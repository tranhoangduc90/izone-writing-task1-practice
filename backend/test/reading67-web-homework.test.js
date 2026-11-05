// SQL thật trên PGlite; Google/owner giả để điều khiển mất ACK, lỗi và thứ tự callback.
// Không gọi AI/Docs thật. Kỳ vọng kiểm bài và hàng Docs cùng commit, không chỉ formatter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {DOC_CONTRACT as LISTENING_DOC_CONTRACT} from '../src/listening-homework67/app.js';
import {PGlite} from '@electric-sql/pglite';
import {createReading67WebStore} from '../src/reading-listening67/web-store.js';
import {createReading67Homework} from '../src/reading-listening67/web-homework.js';
import {HOMEWORK_CTA,HOMEWORK_STATUS,HOMEWORK_PREFIX,planReading67HomeworkWrite} from '../src/reading-listening67/web-homework-docs.js';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const code='67-reading-materials-beyond-concrete-matching-information-nen-cap-1',version='fixture-v1';
const scope={ownerId:A,courseId:'1124',code,version},targets=[...'ABCDEFGH'].map(x=>'p.'+x).concat([1,2,3,4].flatMap(n=>['radar','evidence_l1','section'].map(x=>'q.'+n+'.'+x)));
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
async function fixture(t,{managedCodes=[],ownerEntry,journal}={}){
 const db=new PGlite();t.after(()=>db.close());for(const name of ['web','identity','homework'])await db.exec(await fs.readFile(new URL('../../docs/migrations/2026-10-22-reading67-'+name+'.sql',import.meta.url),'utf8'));
 const docs=memoryDocs(),control={missing:false,wrong:false,failQueue:false};
 const target=s=>({classId:s.courseId,studentRef:s.ownerId,code:s.code,version:s.version,courseId:'classroom',courseWorkId:'work78',submissionId:'sub-'+s.ownerId,documentId:'doc-'+s.ownerId,tabId:'child'});
 const owner={verify:async t=>t,resolve:async s=>{if(control.missing)throw Object.assign(Error('Chưa giao'),{code:'HOMEWORK_NOT_FOUND'});const value=target(s);return control.wrong?{...value,studentRef:B}:value;}};
 const homework=createReading67Homework({db,docs,owner,managedCodes,ownerEntry,journal,metadata:{code,version,homeworkLesson:78},pageBase:'https://page.test/reading-skills67/'});
 const store=createReading67WebStore({db,grader,homework});
 const jobs=async()=> (await db.query('SELECT * FROM reading_listening67.web_homework_job ORDER BY sequence')).rows;
 const due=()=>db.query('UPDATE reading_listening67.web_homework_job SET available_at=now()');
 const drain=async()=>{for(let i=0;i<30;i++)if(!await homework.once())return;throw Error('Queue did not drain');};
 return {db,docs,control,homework,store,target,jobs,due,drain};
}
test('Owner-bound CTA is written and verified per document, without creating answers or changing status text',async t=>{
 const ownerEntry={url(base,s,target){if(!target)return base;const u=new URL(base);u.searchParams.set('mode','student');u.searchParams.set('documentId',target.documentId);return u.href;}};
 const f=await fixture(t,{ownerEntry}),target=f.target(scope);
 await f.homework.register(scope,target);await f.drain();
 const expected=ownerEntry.url(f.homework.entryUrl,scope,target);
 assert.equal(f.docs.get(target.documentId).cta.link.url,expected);
 assert.equal((await f.homework.status(scope)).entryUrl,expected);
 const writes=f.docs.calls.write;await f.homework.register(scope,target);await f.drain();assert.equal(f.docs.calls.write,writes);
 assert.equal((await f.db.query('SELECT count(*)::int n FROM reading_listening67.web_draft')).rows[0].n,0);
 assert.equal(f.docs.get(target.documentId).chars.map(c=>c.text).join(''),'Chữ tay giữ nguyên');
});
test('Docs thêm mã thứ hai sau đăng ký, trước worker: giữ job blocked và không ghi',async t=>{
 const other='new-homework-code',f=await fixture(t,{managedCodes:[code,other]});
 await f.homework.register(scope,f.target(scope));
 const read=f.docs.read;f.docs.read=async id=>{const doc=await read(id);doc.tabs[0].documentTab.body.content.push({paragraph:{elements:[{startIndex:6000,textRun:{content:other+'\n'}}]}});return doc;};
 await f.homework.once();assert.equal(f.docs.calls.write,0);
 const jobs=await f.jobs();assert.equal(jobs[0].status,'blocked');assert.equal(jobs[0].error_code,'DOC_CODE_MISMATCH');
});

test('Vòng sửa: 4/4 nhưng nén còn sai, nộp lại đạt 20/20, Docs/link đúng bản mới và lịch sử nguyên vẹn',async t=>{
 const f=await fixture(t);await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});
 const first=await f.store.submit(scope,{revision:1,requestId:randomUUID()}),job=await f.store.claim(),partial=result(job);
 partial.grading.target_results[0].verdict='partial';await f.store.finish(job,partial);await f.drain();
 let last=(await f.jobs()).at(-1);assert.match(last.payload.text,/đúng 4\/4 câu.*15\/16.*Còn 1 phần cần sửa/);assert.doesNotMatch(last.payload.text,/Đã sửa đúng toàn bộ/);
 const before=await f.store.attempt(scope,first.attemptId),fixed=structuredClone(body);fixed.answers[targets[0]]='Nội dung đã sửa';
 await f.store.save(scope,{baseRevision:1,mutationId:randomUUID(),body:fixed});const second=await f.store.submit(scope,{revision:2,requestId:randomUUID()});const next=await f.store.claim();await f.store.finish(next,result(next));await f.drain();
 last=(await f.jobs()).at(-1);assert.match(last.payload.text,/16\/16.*Đã sửa đúng toàn bộ/);assert.equal(new URL(last.payload.link).searchParams.get('attemptId'),second.attemptId);
 assert.deepEqual(await f.store.attempt(scope,first.attemptId),before);assert.equal((await f.store.history(scope)).length,2);assert.equal((await f.store.draft(scope)).runNo,1);
 const proof=await f.homework.previewStatus(scope);assert.equal(await f.homework.refreshStatus(scope,proof),null);
 await assert.rejects(f.homework.refreshStatus(scope,{...proof,sequence:-1}),{code:'DOC_REFRESH_CHANGED'});
 // Sửa rồi quay về nội dung cũ vẫn là bản nộp mới; không ghép link lịch sử cũ.
 await f.store.save(scope,{baseRevision:2,mutationId:randomUUID(),body});
 const reverted=await f.store.submit(scope,{revision:3,requestId:randomUUID()});assert.notEqual(reverted.attemptId,first.attemptId);assert.equal(reverted.fromCache,false);
});

test('Làm mới dòng Docs cũ thiếu điểm từ kết quả lưu: đọc lại, giữ bài/lịch sử/chữ tay, retry không nhân ghi',async t=>{
 const f=await fixture(t);await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});await f.store.submit(scope,{revision:1,requestId:randomUUID()});const j=await f.store.claim();await f.store.finish(j,result(j));await f.drain();
 const legacy='Đã hoàn thành ngay từ lần đầu. Giảng viên nhấn vào đây để xem kết quả.';
 const b=(await f.db.query('SELECT * FROM reading_listening67.web_homework_binding')).rows[0],last=(await f.jobs()).at(-1);
 await f.db.query('UPDATE reading_listening67.web_homework_binding SET last_doc_text=$1 WHERE id=$2',[legacy,b.id]);
 await f.db.query("UPDATE reading_listening67.web_homework_job SET payload=jsonb_set(payload,'{text}',$1::jsonb) WHERE id=$2",[JSON.stringify(legacy),last.id]);
 const doc=f.docs.get(f.target(scope).documentId),chars=doc.chars,at=chars.map(c=>c.text).join('').indexOf(HOMEWORK_PREFIX)+HOMEWORK_PREFIX.length;
 chars.splice(at,chars.length-at,...[...legacy].map(text=>({text,style:{}})));
 const before=await f.store.attempt(scope,j.attemptId),draft=await f.store.draft(scope),proof=await f.homework.previewStatus(scope);
 assert.equal(proof.previousText,legacy);assert.match(proof.payload.text,/đúng 4\/4 câu/);
 const refresh=await f.homework.refreshStatus(scope,proof);assert.equal(refresh.sequence,last.sequence+1);await f.drain();
 assert.equal((await f.jobs()).at(-1).status,'verified');assert.match(doc.chars.map(c=>c.text).join(''),/Chữ tay giữ nguyên.*\n.*16\/16/s);
 assert.deepEqual(await f.store.attempt(scope,j.attemptId),before);assert.deepEqual(await f.store.draft(scope),draft);
 const writes=f.docs.calls.write;assert.equal(await f.homework.refreshStatus(scope,await f.homework.previewStatus(scope)),null);assert.equal(f.docs.calls.write,writes);
});

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
test('Reset khi chấm: callback cũ không hạ trạng thái mới; không gắn cache của lượt trước vào lượt sau',async t=>{
 const f=await fixture(t);await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});await f.store.submit(scope,{revision:1,requestId:randomUUID()});const oldJob=await f.store.claim();
 await f.store.reset(scope,{baseRevision:1,mutationId:randomUUID()});await f.store.finish(oldJob,result(oldJob));
 let last=(await f.jobs()).at(-1);assert.equal(last.payload.runNo,2);assert.ok(last.payload.text.includes('Đã bắt đầu làm bài số 2'));assert.ok(!last.payload.text.includes('Đã hoàn thành'));
 await f.store.save(scope,{baseRevision:2,mutationId:randomUUID(),body});const cached=await f.store.submit(scope,{revision:3,requestId:randomUUID()});assert.equal(cached.fromCache,false);assert.notEqual(cached.attemptId,oldJob.attemptId);
 const currentJob=await f.store.claim();await f.store.finish(currentJob,result(currentJob));
 last=(await f.jobs()).at(-1);assert.equal(last.payload.runNo,2);assert.ok(last.payload.text.includes('Lần hoàn thành đầu tiên: lượt 1'));assert.equal(last.payload.attemptId,cached.attemptId);
});
test('Hai người xen kẽ và Google chưa có Homework hơn tám lần: pending giữ bài rồi nối đúng đích giao sau',async t=>{
 const f=await fixture(t),other={...scope,ownerId:B};await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});await f.store.save(other,{baseRevision:0,mutationId:randomUUID(),body:{...body,notes:'Người B'}});
 const before=await f.store.draft(scope);f.control.missing=true;
 for(let i=0;i<10;i++){await f.due();await f.homework.once();}
 assert.ok((await f.jobs()).every(j=>j.status==='pending'));assert.equal(f.docs.calls.write,0);assert.deepEqual(await f.store.draft(scope),before);
 f.control.missing=false;await f.due();await f.drain();assert.ok((await f.jobs()).every(j=>j.status==='verified'));
 assert.ok(f.docs.values.has(f.target(scope).documentId));assert.ok(f.docs.values.has(f.target(other).documentId));assert.equal((await f.store.draft(other)).body.notes,'Người B');
});
test('A missing Docs revision pauses writing and replays saved results once permission returns',async t=>{
 const f=await fixture(t);
 await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});
 await f.homework.once(); // CTA was verified before the temporary loss of write access.
 const submission=await f.store.submit(scope,{revision:1,requestId:randomUUID()});
 const grading=await f.store.claim();await f.store.finish(grading,result(grading));
 const saved=await f.store.attempt(scope,submission.attemptId),read=f.docs.read;
 f.docs.read=async id=>{const doc=await read(id);delete doc.revisionId;return doc;};
 const writes=f.docs.calls.write;
 await f.homework.once();
 const stuck=(await f.jobs())[1];
 assert.equal(stuck.status,'pending');assert.equal(stuck.error_code,'DOC_WRITE_UNAVAILABLE');
 assert.equal(await f.homework.once(),false);
 assert.equal(f.docs.calls.write,writes);
 f.docs.read=read;await f.due();await f.drain();
 const jobs=await f.jobs(),last=jobs.at(-1);
 assert.ok(jobs.every(j=>j.status==='verified'));
 assert.equal(new URL(last.payload.link).searchParams.get('attemptId'),submission.attemptId);
 assert.equal(f.docs.get(f.target(scope).documentId).chars.map(c=>c.text).join('').split(HOMEWORK_PREFIX).length-1,1);
 assert.deepEqual(await f.store.attempt(scope,submission.attemptId),saved);
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

const docsReceipts=[];
const docsJournal={docs(scope,receipt){docsReceipts.push(structuredClone({scope,receipt}));return Promise.resolve({ok:true,persisted:true});}};
const settleDocsJournal=()=>new Promise(resolve=>setImmediate(resolve));
test('Docs journal follows immutable queued runs across Reset and verifies the exact destination after SQL commit',async t=>{
 const start=docsReceipts.length,f=await fixture(t,{journal:docsJournal});
 await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});
 const submission=await f.store.submit(scope,{revision:1,requestId:randomUUID()});
 await f.store.reset(scope,{baseRevision:1,mutationId:randomUUID()});await f.drain();await settleDocsJournal();
 const rows=docsReceipts.slice(start),jobs=await f.jobs();assert.ok(rows.length>0);
 for(const row of rows){
  const job=jobs.find(j=>j.id===row.receipt.jobId);assert.ok(job);
  assert.equal(row.scope.ownerId,scope.ownerId);assert.equal(row.scope.courseId,scope.courseId);
  assert.equal(row.scope.runNo,job.kind==='cta'?0:job.payload.runNo);
  if(row.receipt.data.phase==='verified'){assert.equal(job.status,'verified');assert.match(row.receipt.data.targetHash,/^[a-f0-9]{64}$/);assert.ok(row.receipt.data.readCalls>=1);}
 }
 assert.ok(rows.some(r=>r.scope.runNo===1&&r.receipt.attemptId===submission.attemptId));assert.ok(rows.some(r=>r.scope.runNo===2));
 assert.equal((await f.store.draft(scope)).runNo,2);
 assert.equal(JSON.stringify(rows).includes('documentId'),false);assert.equal(JSON.stringify(rows).includes('https://'),false);
 assert.equal(JSON.stringify(rows).includes('payload'),false);
});

test('Docs journal distinguishes missing Homework, denied identity and lost write ACK without inventing verified',async t=>{
 const start=docsReceipts.length,f=await fixture(t,{journal:docsJournal});
 await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});f.control.missing=true;
 await f.homework.once();await settleDocsJournal();
 let rows=docsReceipts.slice(start);assert.ok(rows.some(r=>r.receipt.data.phase==='retry'&&r.receipt.data.errorCode==='HOMEWORK_NOT_FOUND'));
 assert.equal(rows.some(r=>r.receipt.data.phase==='verified'),false);
 f.control.missing=false;await f.due();f.docs.loseNextAck();await f.homework.once();await settleDocsJournal();
 rows=docsReceipts.slice(start);assert.ok(rows.some(r=>r.receipt.data.phase==='write_attempt'));assert.ok(rows.some(r=>r.receipt.data.phase==='retry'));
 const writes=f.docs.calls.write;await f.due();await f.homework.once();await settleDocsJournal();
 assert.equal(f.docs.calls.write,writes);assert.ok(docsReceipts.slice(start).some(r=>r.receipt.data.phase==='verified'&&r.receipt.data.writeCalls===0));
 const deniedStart=docsReceipts.length,g=await fixture(t,{journal:docsJournal});await g.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});g.control.wrong=true;
 await g.homework.once();await settleDocsJournal();
 const denied=docsReceipts.slice(deniedStart);assert.ok(denied.some(r=>r.receipt.data.phase==='blocked'&&r.receipt.data.errorCode==='DOC_IDENTITY_MISMATCH'));
 assert.equal(denied.some(r=>['write_attempt','verified'].includes(r.receipt.data.phase)),false);assert.equal(g.docs.calls.write,0);
 const queued=rows.filter(r=>r.receipt.data.phase==='queued');
 for(const row of queued){const same=queued.filter(r=>r.receipt.receiptId===row.receipt.receiptId);assert.ok(same.every(r=>JSON.stringify(r)===JSON.stringify(row)));}
});

test('A stalled Docs logger cannot delay native work or change its verified result',async t=>{
 const f=await fixture(t,{journal:{docs(){return new Promise(()=>{});}}});await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});
 await f.drain();assert.ok((await f.jobs()).every(job=>job.status==='verified'));
});

test('Docs queued observation waits for the native afterCommit callback and ignores a rolled back queue',async t=>{
 const start=docsReceipts.length,f=await fixture(t,{journal:docsJournal}),transaction=f.db.transaction.bind(f.db);
 f.db.transaction=async action=>{const callbacks=[];const value=await transaction(async tx=>{tx.afterCommit=fn=>callbacks.push(fn);return action(tx);});for(const fn of callbacks)fn();return value;};
 await assert.rejects(f.db.transaction(async tx=>{await f.homework.start(tx,scope);throw Error('ROLLBACK_QUEUE');}),/ROLLBACK_QUEUE/);
 await settleDocsJournal();assert.equal(docsReceipts.length,start);
 await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});await settleDocsJournal();
 const rows=docsReceipts.slice(start);assert.ok(rows.length>0);assert.ok(rows.every(r=>r.receipt.data.phase==='queued'));
 const jobs=await f.jobs();assert.ok(rows.every(r=>jobs.some(j=>j.id===r.receipt.jobId&&j.status==='pending')));
});

test('Reading and Listening Docs interleave owners without sharing their destination or native label',async t=>{
 const start=docsReceipts.length,f=await fixture(t,{journal:docsJournal}),listening={ownerId:B,courseId:scope.courseId,code:'67-listening-journal-fixture',version:'listening-fixture-v1'};
 const listeningDocs={read:async id=>JSON.parse(JSON.stringify(await f.docs.read(id)).replaceAll(HOMEWORK_CTA,LISTENING_DOC_CONTRACT.cta).replaceAll(HOMEWORK_STATUS,LISTENING_DOC_CONTRACT.status).replaceAll(code,listening.code)),write:f.docs.write};
 const homework=createReading67Homework({db:f.db,metadata:{code:listening.code,version:listening.version,homeworkLesson:78},pageBase:'https://page.test/listening-homework/',
  owner:{resolve:async s=>f.target(s)},docs:listeningDocs,journal:docsJournal,planWrite:(doc,binding,job)=>planReading67HomeworkWrite(doc,binding,job,LISTENING_DOC_CONTRACT)});
 const listeningStore=createReading67WebStore({db:f.db,grader,homework});
 await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});await listeningStore.save(listening,{baseRevision:0,mutationId:randomUUID(),body});
 for(let i=0;i<5;i++){const a=await homework.once(),b=await f.homework.once();if(!a&&!b)break;}
 await settleDocsJournal();const rows=docsReceipts.slice(start).filter(r=>r.receipt.data.phase==='verified');
 const reading=rows.filter(r=>r.scope.ownerId===A),listen=rows.filter(r=>r.scope.ownerId===B);
 assert.ok(reading.length>0&&listen.length>0);assert.ok(reading.every(r=>r.scope.code===code));assert.ok(listen.every(r=>r.scope.code===listening.code));
 assert.notEqual(reading[0].receipt.data.targetHash,listen[0].receipt.data.targetHash);
 assert.ok(f.docs.get(f.target(scope).documentId).chars.map(c=>c.text).join('').includes(HOMEWORK_PREFIX));
 assert.ok(f.docs.get(f.target(listening).documentId).chars.map(c=>c.text).join('').includes(LISTENING_DOC_CONTRACT.prefix));
});

test('A Google write 403 is blocked in the native queue and cannot become a verified Docs log',async t=>{
 const start=docsReceipts.length,f=await fixture(t,{journal:docsJournal});await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});
 f.docs.write=async()=>{throw Object.assign(Error('PRIVATE-GOOGLE-ERROR'),{code:'DOC_HTTP_403'});};
 await f.homework.once();await settleDocsJournal();const rows=docsReceipts.slice(start);
 assert.ok(rows.some(r=>r.receipt.data.phase==='blocked'&&r.receipt.data.errorCode==='DOC_HTTP_403'));
 assert.equal(rows.some(r=>['verified','write_received'].includes(r.receipt.data.phase)),false);
 assert.equal(JSON.stringify(rows).includes('PRIVATE-GOOGLE-ERROR'),false);
});

test.after(async()=>{
 if(process.env.HOMEWORK_DOCS_RECEIPTS){const file=process.env.HOMEWORK_DOCS_RECEIPTS;if(!file.match(/^[A-Za-z]:[\\/]/))throw Error('PRIVATE_DOCS_RECEIPTS_PATH_REQUIRED');await fs.writeFile(file,JSON.stringify(docsReceipts,null,2)+'\n',{flag:'wx'});}
});
