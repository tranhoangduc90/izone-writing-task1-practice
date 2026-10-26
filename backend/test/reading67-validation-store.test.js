import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createReading67WebStore,createReading67WebWorker} from '../src/reading-listening67/web-store.js';
import {reading67AnswerFingerprint} from '../src/reading-listening67/web-grader.js';
const ids=Array.from({length:20},(_,i)=>`target-${i}`);
const grader={validationVersion:'test-v1',pins:{sha256:'fixture'},profile:{expected_target_ids:ids},inspectWeb:answers=>({parsed:{targets:ids.map(id=>({target_id:id,source_text:answers[id]||'',source_text_original:answers[id]||'',observed_state:'answered'}))},completeness:{eligible_for_grading:true,filled_cells:20}})};
const scope={ownerId:'owner-A',courseId:'1293',code:'fixture',version:'v1'},body={answers:Object.fromEntries(ids.map(id=>[id,'Nội dung giả.'])),notes:'',flags:[],annotations:[]};
async function setup(t,homework){const db=new PGlite();for(const file of ['2026-10-22-reading67-web.sql','2026-10-26-reading67-validation.sql'])await db.exec(await fs.readFile(new URL('../../docs/migrations/'+file,import.meta.url),'utf8'));t.after(()=>db.close());const store=createReading67WebStore({db,grader,homework});await store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});const sent=await store.submit(scope,{revision:1,requestId:randomUUID()});return {db,store,sent};}
test('Checkpoint/round giữ đúng lease; bổ sung chưa đạt giữ bản nộp và có lịch tiếp tục',async t=>{
 const {db,store,sent}=await setup(t),job=await store.claim(),callId=randomUUID();
 await store.validation.round(job,{callId,phase:'repair',round:1,status:'calling',promptHash:'hash',validationVersion:'test-v1'});
 await assert.rejects(store.validation.round({...job,leaseToken:randomUUID()},{callId,status:'received',response:{}}),{code:'JOB_LEASE_NOT_OWNED'});
 await store.validation.round(job,{callId,phase:'repair',status:'received',response:{results:[]},usage:{totalTokenCount:10}});
 assert.equal((await store.validation.load(job)).received.call_id,callId);
 const state={version:'test-v1',phase:'repair',round:4,lastCallId:callId,issues:[{targetId:ids[0]}]};await store.validation.checkpoint(job,state);await store.validation.defer(job,{details:{state}});
 assert.equal(await store.claim(),null);const current=await store.attempt(scope,sent.attemptId);assert.equal(current.status,'queued');assert.equal(current.result,null);assert.deepEqual(current.snapshot,body);assert.equal(current.validationProgress.pending,1);
 assert.equal((await db.query("SELECT status FROM reading_listening67.web_validation_round WHERE call_id=$1",[callId])).rows[0].status,'applied');
 assert.equal((await db.query('SELECT count(*)::int n FROM reading_listening67.web_validation_event')).rows[0].n,1);
});
test('Crash trước checkpoint phát lại response; crash chưa rõ response giữ needs_review',async t=>{
 const {db,store}=await setup(t);let job=await store.claim();const callId=randomUUID();
 await store.validation.round(job,{callId,phase:'initial',round:1,status:'calling',promptHash:'hash'});await store.validation.round(job,{callId,status:'received',response:{known:true}});
 await db.query("UPDATE reading_listening67.web_job SET lease_until=now()-interval '1 second' WHERE id=$1",[job.jobId]);await store.recoverExpired();job=await store.claim();assert(job);assert.equal((await store.validation.load(job)).received.response.known,true);
 await store.validation.checkpoint(job,{version:'test-v1',phase:'review',round:1,lastCallId:callId});
 const nextId=randomUUID();await store.validation.round(job,{callId:nextId,phase:'review',round:2,status:'calling',promptHash:'h'});
 await db.query("UPDATE reading_listening67.web_job SET lease_until=now()-interval '1 second' WHERE id=$1",[job.jobId]);await store.recoverExpired();assert.equal(await store.claim(),null);
 assert.equal((await db.query('SELECT status,error_code FROM reading_listening67.web_job WHERE id=$1',[job.jobId])).rows[0].status,'needs_review');
});
test('Hai học viên xen kẽ, round không gắn nhầm job; result đến muộn không sửa nháp mới',async t=>{
 const {store,db,sent}=await setup(t),other={...scope,ownerId:'owner-B'};
 await store.save(other,{baseRevision:0,mutationId:randomUUID(),body});await store.submit(other,{revision:1,requestId:randomUUID()});const a=await store.claim(),b=await store.claim();
 const ca=randomUUID();await store.validation.round(a,{callId:ca,phase:'repair',round:1,status:'calling',promptHash:'a'});
 await assert.rejects(store.validation.round(b,{callId:ca,status:'received',response:{wrong:true}}),{code:'JOB_ROUND_NOT_OWNED'});
 assert.equal((await db.query('SELECT response FROM reading_listening67.web_validation_round WHERE call_id=$1',[ca])).rows[0].response,null);
 const changed={...body,notes:'Nháp mới của A.'};await store.save(scope,{baseRevision:1,mutationId:randomUUID(),body:changed});
 const result={pins:grader.pins,context:{operationId:a.jobId,sourceDigest:a.inputHash},grading:{validation:{version:'test-v1',reviewedHash:'reviewed'},target_results:ids.map(target_id=>({target_id,verdict:'correct'}))},feedback:{}};
 await assert.rejects(store.finish(a,result),{code:'RESULT_VALIDATION_REQUIRED'});
 await store.validation.round(a,{callId:ca,status:'received',response:{valid:true}});await store.validation.checkpoint(a,{version:'test-v1',phase:'complete',reviewedHash:'reviewed',lastCallId:ca});await store.finish(a,result);
 assert.deepEqual((await store.draft(scope)).body,changed);assert.deepEqual((await store.attempt(scope,sent.attemptId)).snapshot,body);assert.equal((await store.attempt(scope,sent.attemptId)).status,'done');
});
test('Bài mới được phục vụ trước job bổ sung được xếp lại sau nó',async t=>{
 const {store,db}=await setup(t);const original=await store.claim(),other={...scope,ownerId:'owner-B'};
 await store.save(other,{baseRevision:0,mutationId:randomUUID(),body});const sent=await store.submit(other,{revision:1,requestId:randomUUID()});
 const state={version:'test-v1',phase:'repair',round:1,issues:[]};await store.validation.checkpoint(original,state);await store.validation.defer(original,{details:{state}});
 await db.query("UPDATE reading_listening67.web_validation SET next_attempt_at=now()-interval '1 millisecond' WHERE job_id=$1",[original.jobId]);
 assert.equal((await store.claim()).attemptId,sent.attemptId);
});
test('Kết quả phục hồi có sự kiện Homework mới, không dùng lại thông báo lỗi cũ',async t=>{
 const events=[];const homework={start:async()=>{},submitted:async()=>{},outcome:async(_tx,_scope,key)=>events.push(key)};
 const {store}=await setup(t,homework),job=await store.claim();await store.validation.checkpoint(job,{version:'test-v1',phase:'complete',reviewedHash:'reviewed'});
 await store.finish(job,{pins:grader.pins,context:{operationId:job.jobId,sourceDigest:job.inputHash},grading:{validation:{version:'test-v1',reviewedHash:'reviewed'},target_results:ids.map(target_id=>({target_id,verdict:'correct'}))}});
 assert.deepEqual(events,[job.jobId+':test-v1:complete']);assert.notEqual(events[0],job.jobId);
});
