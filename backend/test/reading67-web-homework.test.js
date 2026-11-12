// SQL thật trên PGlite; Google/owner giả để điều khiển mất ACK, lỗi và thứ tự callback.
// Không gọi AI/Docs thật. Kỳ vọng kiểm bài và hàng Docs cùng commit, không chỉ formatter.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createReading67WebStore} from '../src/reading-listening67/web-store.js';
import {createReading67Homework} from '../src/reading-listening67/web-homework.js';
import {memoryDocs} from '../test-support/reading67-memory-docs.js';
import {HOMEWORK_PREFIX} from '../src/reading-listening67/web-homework-docs.js';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const code='67-reading-materials-beyond-concrete-matching-information-nen-cap-1',version='fixture-v1';
const scope={ownerId:A,courseId:'1124',code,version},targets=[...'ABCDEFGH'].map(x=>'p.'+x).concat([1,2,3,4].flatMap(n=>['radar','evidence_l1','section'].map(x=>'q.'+n+'.'+x)));
const body={answers:Object.fromEntries(targets.map(id=>[id,'Bài tự viết'])),notes:'Ghi chú riêng',flags:[],annotations:[]};
const grader={pins:{sha256:'a'.repeat(64)},profile:{expected_target_ids:targets},inspectWeb:answers=>({parsed:{targets:Object.entries(answers).map(([target_id,source_text])=>({target_id,source_text}))},completeness:{filled_cells:Object.keys(answers).length,eligible_for_grading:Object.keys(answers).length>=16}})};
const result=job=>({pins:grader.pins,context:{operationId:job.jobId,sourceDigest:job.inputHash},grading:{target_results:targets.map(target_id=>({target_id,verdict:'correct'}))},feedback:{}});
async function fixture(t,{managedCodes=[],ownerEntry,practiceRequired=false}={}){
 const db=new PGlite();t.after(()=>db.close());for(const name of ['web','identity','homework'])await db.exec(await fs.readFile(new URL('../../docs/migrations/2026-10-22-reading67-'+name+'.sql',import.meta.url),'utf8'));
 const docs=memoryDocs(code),control={missing:false,wrong:false,failQueue:false};
 const target=s=>({classId:s.courseId,studentRef:s.ownerId,code:s.code,version:s.version,courseId:'classroom',courseWorkId:'work78',submissionId:'sub-'+s.ownerId,documentId:'doc-'+s.ownerId,tabId:'child'});
 const owner={verify:async t=>t,resolve:async s=>{if(control.missing)throw Object.assign(Error('Chưa giao'),{code:'HOMEWORK_NOT_FOUND'});const value=target(s);return control.wrong?{...value,studentRef:B}:value;}};
 if(practiceRequired)await db.exec(await fs.readFile(new URL('../../docs/migrations/2026-10-29-reading67-share-practice.sql',import.meta.url),'utf8'));
 const homework=createReading67Homework({db,docs,owner,managedCodes,ownerEntry,metadata:{code,version,homeworkLesson:78,practiceRequired},pageBase:'https://page.test/reading-skills67/'});
 const store=createReading67WebStore({db,grader,homework});
 const jobs=async()=> (await db.query('SELECT * FROM reading_listening67.web_homework_job ORDER BY sequence')).rows;
 const due=()=>db.query('UPDATE reading_listening67.web_homework_job SET available_at=now()');
 const drain=async()=>{for(let i=0;i<30;i++)if(!await homework.once())return;throw Error('Queue did not drain');};
 return {db,docs,control,homework,store,target,jobs,due,drain};
}

test('Share before Reading starts writes a valid teacher link to Docs without claiming a Reading attempt',async t=>{
 const f=await fixture(t,{practiceRequired:true});await f.homework.register(scope,f.target(scope));await f.drain();
 const id=randomUUID();await f.db.query('INSERT INTO reading_listening67.web_share_practice(id,owner_id,course_id,assignment_code,content_version,share_url,request_id,status) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,scope.ownerId,scope.courseId,scope.code,scope.version,'https://chatgpt.com/share/'+id,randomUUID(),'rejected']);
 for(const status of ['rejected','accepted']){
  await f.db.query('UPDATE reading_listening67.web_share_practice SET status=$1 WHERE id=$2',[status,id]);
  await f.db.transaction(tx=>f.homework.practiceChanged(tx,scope,id,{status}));await f.drain();
  const job=(await f.jobs()).at(-1);assert.equal(job.status,'verified');
  assert.match(job.payload.text,/Chưa bắt đầu làm bài Reading/);assert.match(job.payload.text,/Giảng viên nhấn vào đây/);
  assert.equal(new URL(job.payload.link).searchParams.get('studentRef'),scope.ownerId);assert.equal(job.payload.attemptId,null);
 }
 assert.equal((await f.db.query('SELECT count(*)::int n FROM reading_listening67.web_attempt')).rows[0].n,0);
 assert.match(f.docs.get(f.target(scope).documentId).chars.map(c=>c.text).join(''),/^Chữ tay giữ nguyên\n/);
});
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
