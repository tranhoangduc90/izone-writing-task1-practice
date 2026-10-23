// SQL thật trên PGlite; Google/owner giả để điều khiển mất ACK, lỗi và thứ tự callback.
// Không gọi AI/Docs thật. Kỳ vọng kiểm bài và hàng Docs cùng commit, không chỉ formatter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createReading67WebStore} from '../src/reading-listening67/web-store.js';
import {createReading67Homework} from '../src/reading-listening67/web-homework.js';
import {HOMEWORK_CTA,HOMEWORK_STATUS,HOMEWORK_PREFIX} from '../src/reading-listening67/web-homework-docs.js';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const code='67-reading-materials-beyond-concrete-matching-information-nen-cap-1',version='fixture-v1';
const scope={ownerId:A,courseId:'1124',code,version},targets=Array.from({length:20},(_,i)=>'target.'+i);
const body={answers:Object.fromEntries(targets.map(id=>[id,'Bài tự viết'])),notes:'Ghi chú riêng',flags:[],annotations:[]};
const grader={pins:{sha256:'a'.repeat(64)},profile:{expected_target_ids:targets},inspectWeb:answers=>({parsed:{targets:Object.entries(answers).map(([target_id,source_text])=>({target_id,source_text}))},completeness:{filled_cells:Object.keys(answers).length,eligible_for_grading:Object.keys(answers).length>=16}})};
const result=job=>({pins:grader.pins,context:{operationId:job.jobId,sourceDigest:job.inputHash},grading:{target_results:targets.map(target_id=>({target_id,verdict:'correct'}))},feedback:{}});
function memoryDocs(){
 const values=new Map(),calls={read:0,write:0};let loseAck=false;
 const chars=text=>[...text].map(text=>({text,style:{link:{url:'https://manual.test/keep'},bold:true}}));
 // Fixture chỉ dùng ký tự BMP; index Google/JS cùng đơn vị UTF-16.
 const get=id=>{if(!values.has(id))values.set(id,{chars:chars('Chữ tay giữ nguyên'),cta:{},revision:1});return values.get(id);};
 const paragraph=(start,text,style={})=>({paragraph:{elements:[{startIndex:start,textRun:{content:text+'\n',textStyle:style}}]}});
 function document(id){const state=get(id),elements=state.chars.map((c,i)=>({startIndex:500+i,textRun:{content:c.text,textStyle:c.style}}));elements.push({startIndex:500+state.chars.length,textRun:{content:'\n',textStyle:{}}});
  return {documentId:id,revisionId:'r'+state.revision,tabs:[{tabProperties:{tabId:'child'},documentTab:{body:{content:[{table:{tableRows:[{tableCells:[{content:[paragraph(1,HOMEWORK_CTA,state.cta),paragraph(100,code)]}]},{tableCells:[{content:[paragraph(300,HOMEWORK_STATUS)]}]},{tableCells:[{content:[{paragraph:{elements}}]}]}]}},paragraph(5000,'Bài Reading khác: nguyên văn/link giữ nguyên',{link:{url:'https://manual.test/other'}})]}}}]};
 }
 return {calls,values,get,loseNextAck(){loseAck=true;},read:async id=>{calls.read++;return document(id);},write:async(id,plan)=>{
  const state=get(id);assert.equal(plan.revisionId,'r'+state.revision);calls.write++;
  for(const r of plan.requests){
   if(r.insertText){const at=r.insertText.location.index-500;assert.ok(at>=0);state.chars.splice(at,0,...chars(r.insertText.text));}
   if(r.deleteContentRange){const {startIndex,endIndex}=r.deleteContentRange.range;assert.ok(startIndex>=500);state.chars.splice(startIndex-500,endIndex-startIndex);}
   if(r.updateTextStyle){const {range,textStyle,fields}=r.updateTextStyle;if(range.startIndex===1){state.cta={...state.cta,...textStyle};continue;}
    for(let i=range.startIndex-500;i<range.endIndex-500;i++)for(const field of fields.split(',')){if(textStyle[field]===undefined)delete state.chars[i].style[field];else state.chars[i].style[field]=structuredClone(textStyle[field]);}
   }
  }
  state.revision++;if(loseAck){loseAck=false;throw Error('Mất ACK sau khi Google đã ghi');}
 }};
}
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());for(const name of ['web','identity','homework'])await db.exec(await fs.readFile(new URL('../../docs/migrations/2026-10-22-reading67-'+name+'.sql',import.meta.url),'utf8'));
 const docs=memoryDocs(),control={missing:false,wrong:false,failQueue:false};
 const target=s=>({classId:s.courseId,studentRef:s.ownerId,code:s.code,version:s.version,courseId:'classroom',courseWorkId:'work78',submissionId:'sub-'+s.ownerId,documentId:'doc-'+s.ownerId,tabId:'child'});
 const owner={verify:async t=>t,resolve:async s=>{if(control.missing)throw Object.assign(Error('Chưa giao'),{code:'HOMEWORK_NOT_FOUND'});const value=target(s);return control.wrong?{...value,studentRef:B}:value;}};
 const homework=createReading67Homework({db,docs,owner,metadata:{code,version,homeworkLesson:78},pageBase:'https://page.test/reading-skills67/'});
 const store=createReading67WebStore({db,grader,homework});
 const jobs=async()=> (await db.query('SELECT * FROM reading_listening67.web_homework_job ORDER BY sequence')).rows;
 const due=()=>db.query('UPDATE reading_listening67.web_homework_job SET available_at=now()');
 const drain=async()=>{for(let i=0;i<30;i++)if(!await homework.once())return;throw Error('Queue did not drain');};
 return {db,docs,control,homework,store,target,jobs,due,drain};
}
test('Save và job cùng transaction; autosave không gọi Google, CTA/status đọc lại đúng rồi mới verified',async t=>{
 const f=await fixture(t);await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});
 assert.equal(f.docs.calls.read,0);assert.deepEqual((await f.jobs()).map(j=>[j.sequence,j.kind,j.status]),[[0,'cta','pending'],[1,'status','pending']]);
 await f.drain();assert.ok((await f.jobs()).every(j=>j.status==='verified'));assert.equal((await f.homework.status(scope)).status,'verified');
 const saved=f.docs.get(f.target(scope).documentId);assert.ok(saved.chars.map(c=>c.text).join('').startsWith('Chữ tay giữ nguyên\n'+HOMEWORK_PREFIX));
 assert.ok(saved.chars.slice(0,'Chữ tay giữ nguyên'.length).every(c=>c.style.link.url==='https://manual.test/keep'&&c.style.bold));
 const original=f.db.query.bind(f.db);let injected=false;
 const broken={...f.db,query:original,transaction:fn=>f.db.transaction(tx=>fn({query:async(sql,args)=>{if(sql.startsWith('INSERT INTO reading_listening67.web_homework_job')){injected=true;throw Error('disk');}return tx.query(sql,args);}}))};
 const otherScope={...scope,ownerId:B},h=createReading67Homework({db:broken,docs:f.docs,owner:{},metadata:{code,version,homeworkLesson:78},pageBase:'https://page.test/reading-skills67/'}),store=createReading67WebStore({db:broken,grader,homework:h});
 await assert.rejects(store.save(otherScope,{baseRevision:0,mutationId:randomUUID(),body}),/disk/);assert.ok(injected);assert.equal((await f.store.draft(otherScope)).revision,0);
});
test('Nộp lặp, hoàn tất và retry mất ACK: một lượt, đúng link attempt, không nhân dòng hoặc gọi Google lần hai',async t=>{
 const f=await fixture(t);await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});await f.drain();
 const submission=await f.store.submit(scope,{revision:1,requestId:randomUUID()});await f.store.submit(scope,{revision:1,requestId:randomUUID()});
 assert.equal((await f.jobs()).filter(j=>j.event_key.startsWith('submitted:')).length,1);
 const job=await f.store.claim();await f.store.finish(job,result(job));const draftBefore=await f.store.draft(scope);
 await f.homework.once();f.docs.loseNextAck();await f.homework.once();assert.equal((await f.jobs()).at(-1).status,'pending');
 const writes=f.docs.calls.write;await f.due();await f.homework.once();assert.equal(f.docs.calls.write,writes);
 const jobs=await f.jobs(),last=jobs.at(-1);assert.equal(last.status,'verified');assert.ok(last.payload.text.includes('Đã hoàn thành'));
 assert.equal(new URL(last.payload.link).searchParams.get('attemptId'),submission.attemptId);
 assert.equal(f.docs.get(f.target(scope).documentId).chars.map(c=>c.text).join('').split(HOMEWORK_PREFIX).length-1,1);
 assert.deepEqual(await f.store.draft(scope),draftBefore);
});
test('Reset khi chấm: callback lượt cũ không hạ trạng thái lượt mới; cache kết quả ở lượt mới vẫn ghi đúng số lượt',async t=>{
 const f=await fixture(t);await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});await f.store.submit(scope,{revision:1,requestId:randomUUID()});const oldJob=await f.store.claim();
 await f.store.reset(scope,{baseRevision:1,mutationId:randomUUID()});await f.store.finish(oldJob,result(oldJob));
 let last=(await f.jobs()).at(-1);assert.equal(last.payload.runNo,2);assert.ok(last.payload.text.includes('Đã bắt đầu làm bài số 2'));assert.ok(!last.payload.text.includes('Đã hoàn thành'));
 await f.store.save(scope,{baseRevision:2,mutationId:randomUUID(),body});const cached=await f.store.submit(scope,{revision:3,requestId:randomUUID()});assert.equal(cached.fromCache,true);
 last=(await f.jobs()).at(-1);assert.equal(last.payload.runNo,2);assert.ok(last.payload.text.includes('Lần hoàn thành đầu tiên: lượt 1'));assert.equal(last.payload.attemptId,oldJob.attemptId);
});
test('Hai người xen kẽ và Google chưa có Homework hơn tám lần: pending giữ bài rồi nối đúng đích giao sau',async t=>{
 const f=await fixture(t),other={...scope,ownerId:B};await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});await f.store.save(other,{baseRevision:0,mutationId:randomUUID(),body:{...body,notes:'Người B'}});
 const before=await f.store.draft(scope);f.control.missing=true;
 for(let i=0;i<10;i++){await f.due();await f.homework.once();}
 assert.ok((await f.jobs()).every(j=>j.status==='pending'));assert.equal(f.docs.calls.write,0);assert.deepEqual(await f.store.draft(scope),before);
 f.control.missing=false;await f.due();await f.drain();assert.ok((await f.jobs()).every(j=>j.status==='verified'));
 assert.ok(f.docs.values.has(f.target(scope).documentId));assert.ok(f.docs.values.has(f.target(other).documentId));assert.equal((await f.store.draft(other)).body.notes,'Người B');
});
test('Sai UUID bị blocked trước đọc Docs; job sau cùng người không vượt qua; bài đã lưu vẫn nguyên',async t=>{
 const f=await fixture(t);await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});const before=await f.store.draft(scope);f.control.wrong=true;
 await f.homework.once();assert.equal(f.docs.calls.read,0);const jobs=await f.jobs();assert.equal(jobs[0].status,'blocked');assert.equal(jobs[0].error_code,'DOC_IDENTITY_MISMATCH');assert.equal(await f.homework.once(),false);assert.deepEqual(await f.store.draft(scope),before);
});
test('Chấm xong ngược thứ tự trong một lượt: trạng thái luôn theo bản nộp mới nhất',async t=>{
 const f=await fixture(t);await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});await f.store.submit(scope,{revision:1,requestId:randomUUID()});const old=await f.store.claim();
 const changed=structuredClone(body);changed.answers[targets[0]]='Nội dung sửa';await f.store.save(scope,{baseRevision:1,mutationId:randomUUID(),body:changed});const newer=await f.store.submit(scope,{revision:2,requestId:randomUUID()});
 await f.store.finish(old,result(old));let last=(await f.jobs()).at(-1);assert.equal(last.payload.attemptId,newer.attemptId);assert.match(last.payload.text,/đang chờ chấm/);
 const next=await f.store.claim();await f.store.finish(next,result(next));last=(await f.jobs()).at(-1);assert.equal(last.payload.attemptId,newer.attemptId);assert.match(last.payload.text,/Đã hoàn thành/);
});
test('Chấm lỗi hoặc worker hết hạn không ghi hoàn thành; kết quả chưa rõ không tự chấm lại',async t=>{
 for(const expired of [false,true]){
  const f=await fixture(t);await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});await f.store.submit(scope,{revision:1,requestId:randomUUID()});const job=await f.store.claim();
  if(expired){await f.db.query("UPDATE reading_listening67.web_job SET lease_until=now()-interval '1 second' WHERE id=$1",[job.jobId]);await f.store.recoverExpired();}
  else await f.store.fail(job,{code:'AI_OUTCOME_UNKNOWN'});
  const last=(await f.jobs()).at(-1);assert.match(last.payload.text,/chưa có kết quả chấm/);assert.doesNotMatch(last.payload.text,/Đã hoàn thành/);assert.equal(await f.store.claim(),null);
 }
});
