import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import crypto from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import {createWritingPracticeService} from '../ops/sw-task2-production/service-runtime.js';
import {createDeferredVocabularyService,claimVocabulary,recoverVocabulary,deferredQueueStatus,installDeferredVocabularyRoutes} from '../ops/sw-task2-production/deferred-vocabulary.mjs';

const uuid=()=>crypto.randomUUID();
const body={body_choice:'body1',topic_sentence:'A supported topic',body1_idea1:'First idea',body1_idea2:'Second idea',body2_idea1:'',body2_idea2:'',idea1_a:'A1',idea1_x:'X1',idea1_b:'B1',idea2_a:'A2',idea2_x:'X2',idea2_b:'B2'};
const vocabulary=label=>['A1','X1','B1','A2','X2','B2'].map(point=>({point,terms:[{phrase:label+point,meaningVi:'Nghĩa thử'}]}));
const model={prompt:'Pinned vocabulary prompt with the approved arguments',modelId:'gemini-3.1-pro-preview',thinkingLevel:'high'};
async function fixture(t){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`CREATE SCHEMA writing_practice;
 CREATE TABLE writing_practice.activity(id int PRIMARY KEY,grading_pool text);
 INSERT INTO writing_practice.activity VALUES(1,'task2');
 CREATE TABLE writing_practice.activity_session(id uuid PRIMARY KEY,public_id uuid,activity_id int,response_data jsonb);
 CREATE TABLE writing_practice.session_section(session_id uuid,section_key text,locked bool DEFAULT false,fail_streak int DEFAULT 0,round_number int DEFAULT 1,updated_at timestamptz DEFAULT now());
 CREATE TABLE writing_practice.check_attempt(id uuid PRIMARY KEY,public_id uuid,session_id uuid,section_key text,
 round_number int DEFAULT 1,comment_number int DEFAULT 1,body_hash text DEFAULT 'hash',snapshot jsonb,grading_context jsonb,
 status text DEFAULT 'leased',result_status text,feedback text,result_artifacts jsonb DEFAULT '{}',grading_meta jsonb DEFAULT '{}',
 error_code text,retry_count int DEFAULT 1,worker_id text,lease_token uuid,lease_expires_at timestamptz,late_callback_token uuid,
 version int DEFAULT 1,completed_at timestamptz,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
 CREATE TABLE writing_practice.comment(id uuid DEFAULT gen_random_uuid(),attempt_id uuid,session_id uuid,section_key text,status text,content text);`);
 await db.exec(await readFile(new URL('../ops/sw-task2-production/deferred-vocabulary.sql',import.meta.url),'utf8'));
 const query=async(sql,args)=>{const r=await db.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0};};
 const pool={query,connect:async()=>({query,release(){}})};
 const grade=createWritingPracticeService({pool}),vocab=createDeferredVocabularyService({pool});
 async function seed(label='one'){
  const session=uuid(),id=uuid(),ref=uuid(),lease=uuid(),responses={...body,idea2_x:label};
  await query('INSERT INTO writing_practice.activity_session VALUES($1,$1,1,$2::jsonb)',[session,JSON.stringify(responses)]);
  for(const section of ['topic_sentence','supporting_idea_1','supporting_idea_2','draft'])await query('INSERT INTO writing_practice.session_section(session_id,section_key,locked) VALUES($1,$2,$3)',[session,section,['topic_sentence','supporting_idea_1'].includes(section)]);
  await query(`INSERT INTO writing_practice.check_attempt(id,public_id,session_id,section_key,snapshot,lease_token,lease_expires_at,created_at)
   VALUES($1,$2,$3,'supporting_idea_2',$4::jsonb,$5,now()+interval '7 minutes',now()-interval '20 seconds')`,[id,ref,session,JSON.stringify(responses),lease]);
  await query("INSERT INTO writing_practice.comment(attempt_id,session_id,section_key,status,content) VALUES($1,$2,'supporting_idea_2','queued','Đang chấm')",[id,session]);
  const input={jobRef:ref,leaseToken:lease,resultStatus:'passed',feedback:'Nhận xét đúng nguyên bản',artifacts:{vocabularyStatus:'pending',bodyKey:'body1'},rawModelMeta:{modelId:'gemini-3.1-pro-preview',thinkingLevel:'high',deferredVocabulary:model}};
  return {session,id,ref,lease,input,responses};
 }
 const claim=()=>pool.connect().then(async c=>{try{await c.query('BEGIN');const job=await claimVocabulary(c,{workerId:'test',leaseSeconds:420});await c.query('COMMIT');return job;}catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}});
 const result=(job,label='fixture')=>({jobRef:job.jobRef,leaseToken:job.leaseToken,artifacts:{vocabularyStatus:'available',bodyKey:'body1',vocabulary:vocabulary(label)},rawModelMeta:{modelId:model.modelId,thinkingLevel:model.thinkingLevel}});
 const row=async id=>(await query('SELECT * FROM writing_practice.check_attempt WHERE id=$1',[id])).rows[0];
 return {db,pool,query,grade,vocab,seed,claim,result,row};
}

test('feedback and original gates are committed before vocabulary is claimed or returned',async t=>{
 const f=await fixture(t),s=await f.seed();const receipt=await f.grade.completeJob(s.input);
 assert.ok(receipt.vocabularyJobRef);const a=await f.row(s.id);
 assert.equal(a.feedback,s.input.feedback);assert.equal(a.status,'completed');assert.equal(a.result_status,'passed');
 assert.equal(a.result_artifacts.vocabularyStatus,'pending');assert.equal(a.result_artifacts.vocabulary,undefined);
 const states=(await f.query('SELECT section_key,locked FROM writing_practice.session_section WHERE session_id=$1',[s.session])).rows;
 assert.deepEqual(Object.fromEntries(states.map(s=>[s.section_key,s.locked])),{topic_sentence:true,supporting_idea_1:true,supporting_idea_2:true,draft:false});
 const job=await f.claim();assert.equal(job.modelId,model.modelId);assert.equal(job.thinkingLevel,model.thinkingLevel);assert.equal(job.vocabularyPrompt,model.prompt);
 await f.vocab.complete(f.result(job));const after=await f.row(s.id);
 assert.equal(after.feedback,a.feedback);assert.equal(after.result_status,a.result_status);assert.equal(after.completed_at.toISOString(),a.completed_at.toISOString());
 assert.equal(after.result_artifacts.vocabulary.length,6);
});
test('needs-revision keeps the original failed-streak gate and creates no vocabulary',async t=>{
 const f=await fixture(t),s=await f.seed();s.input.resultStatus='needs_revision';s.input.artifacts={};s.input.rawModelMeta={};
 await f.grade.completeJob(s.input);assert.equal(await f.claim(),null);
 const state=(await f.query("SELECT * FROM writing_practice.session_section WHERE session_id=$1 AND section_key='supporting_idea_2'",[s.session])).rows[0];
 assert.equal(state.locked,false);assert.equal(state.fail_streak,1);
});
test('invalid model rolls back feedback and gate publication atomically',async t=>{
 const f=await fixture(t),s=await f.seed();s.input.rawModelMeta.deferredVocabulary={...model,thinkingLevel:'medium'};
 await assert.rejects(f.grade.completeJob(s.input));assert.equal((await f.row(s.id)).status,'leased');
 assert.equal((await f.query("SELECT locked FROM writing_practice.session_section WHERE session_id=$1 AND section_key='supporting_idea_2'",[s.session])).rows[0].locked,false);
});
test('lost ACK replay publishes one comment and one job, and changed replay is rejected',async t=>{
 const f=await fixture(t),s=await f.seed(),first=await f.grade.completeJob(s.input),before=await f.row(s.id);
 const second=await f.grade.completeJob(s.input);assert.equal(second.vocabularyJobRef,first.vocabularyJobRef);assert.equal(second.idempotent,true);
 assert.equal((await f.row(s.id)).version,before.version);assert.equal((await f.query('SELECT count(*) n FROM writing_practice.deferred_vocabulary_job')).rows[0].n,1);
 await assert.rejects(f.grade.completeJob({...s.input,feedback:'Changed'}),{code:'VOCABULARY_COMPLETION_MISMATCH'});
});
test('out-of-order vocabulary updates only its own attempt/student',async t=>{
 const f=await fixture(t),a=await f.seed('alpha'),b=await f.seed('beta');
 await f.grade.completeJob(a.input);await f.grade.completeJob(b.input);
 const one=await f.claim(),two=await f.claim();assert.notEqual(one.sourceAttemptRef,two.sourceAttemptRef);
 await f.vocab.complete(f.result(two,'second'));await f.vocab.complete(f.result(one,'first'));
 const byRef=new Map([[one.sourceAttemptRef,'first'],[two.sourceAttemptRef,'second']]);
 for(const s of [a,b])assert.equal((await f.row(s.id)).result_artifacts.vocabulary[0].terms[0].phrase,byRef.get(s.ref)+'A1');
});
for(const change of ['edit','body','round','newer'])test('late vocabulary after '+change+' cannot attach or change approval',async t=>{
 const f=await fixture(t),s=await f.seed();await f.grade.completeJob(s.input);const job=await f.claim();
 if(change==='edit'||change==='body')await f.query('UPDATE writing_practice.activity_session SET response_data=response_data||$2::jsonb WHERE id=$1',[s.session,JSON.stringify(change==='edit'?{idea2_x:'Edited bridge'}:{body_choice:'body2'})]);
 if(change==='round')await f.query("UPDATE writing_practice.session_section SET round_number=round_number+1,locked=false WHERE session_id=$1 AND section_key='supporting_idea_2'",[s.session]);
 if(change==='newer')await f.query("INSERT INTO writing_practice.check_attempt(id,public_id,session_id,section_key,snapshot,status) VALUES($1,$1,$2,'supporting_idea_2','{}','queued')",[uuid(),s.session]);
 const reply=await f.vocab.complete(f.result(job));assert.equal(reply.status,'superseded');
 const a=await f.row(s.id);assert.equal(a.feedback,s.input.feedback);assert.equal(a.result_status,'passed');assert.equal(a.result_artifacts.vocabulary,undefined);
});
test('stale work is discarded before AI claim',async t=>{
 const f=await fixture(t),s=await f.seed();await f.grade.completeJob(s.input);
 await f.query("UPDATE writing_practice.activity_session SET response_data=response_data||'{\"idea1_a\":\"Changed\"}'::jsonb WHERE id=$1",[s.session]);
 assert.equal(await f.claim(),null);assert.equal((await f.query('SELECT status FROM writing_practice.deferred_vocabulary_job')).rows[0].status,'superseded');
});
test('foreign lease, malformed result and changed lost-ACK replay are rejected',async t=>{
 const f=await fixture(t),s=await f.seed();await f.grade.completeJob(s.input);const job=await f.claim(),result=f.result(job);
 await assert.rejects(f.vocab.complete({...result,leaseToken:uuid()}),{code:'LEASE_NOT_OWNED'});
 await assert.rejects(f.vocab.complete({...result,artifacts:{...result.artifacts,bodyKey:'body2'}}),{code:'VOCABULARY_RESULT_INVALID'});
 await assert.rejects(f.vocab.complete({...result,artifacts:{...result.artifacts,vocabulary:[...vocabulary('x').slice(0,5),vocabulary('x')[0]]}}));
 await f.vocab.complete(result);assert.equal((await f.vocab.complete(result)).idempotent,true);
 await assert.rejects(f.vocab.complete(f.result(job,'different')),{code:'VOCABULARY_RESULT_MISMATCH'});
});
test('recovery and three bounded failures preserve the completed grading result',async t=>{
 const f=await fixture(t),s=await f.seed();await f.grade.completeJob(s.input);let job=await f.claim();
 await f.query("UPDATE writing_practice.deferred_vocabulary_job SET lease_until=now()-interval '1 second'");
 assert.equal((await deferredQueueStatus(f.pool,true)).recoverDue,true);
 assert.equal(await recoverVocabulary(f.pool),1);
 await assert.rejects(f.vocab.complete(f.result(job)),{code:'LEASE_NOT_OWNED'});
 for(let n=2;n<=3;n++){
  await f.query("UPDATE writing_practice.deferred_vocabulary_job SET next_attempt_at=now()-interval '1 second'");job=await f.claim();assert.ok(job);
  assert.equal((await f.vocab.failed({jobRef:job.jobRef,leaseToken:job.leaseToken,errorCode:'SYNTHETIC_503'})).status,n===3?'failed':'queued');
 }
 assert.equal(await f.claim(),null);assert.equal((await f.row(s.id)).feedback,s.input.feedback);assert.equal((await f.row(s.id)).result_artifacts.vocabularyStatus,'unavailable');
});
test('the existing grading FIFO and worker status include durable vocabulary',async t=>{
 const f=await fixture(t),s=await f.seed();await f.grade.completeJob(s.input);
 assert.deepEqual(await deferredQueueStatus(f.pool,true),{database:'postgres',queued:1,recoverDue:false});
 const other=await f.seed();await f.query("UPDATE writing_practice.check_attempt SET status='queued' WHERE id=$1",[other.id]);
 assert.equal(await f.claim(),null);await f.query("UPDATE writing_practice.check_attempt SET status='failed' WHERE id=$1",[other.id]);assert.ok(await f.claim());
});
test('vocabulary callbacks require the native internal credential',async t=>{
 const f=await fixture(t),app=express();app.use(express.json());installDeferredVocabularyRoutes(app,{pool:f.pool,config:{internalApiToken:'fixture-secret'}});
 app.use((e,q,r,n)=>r.status(e.status||400).json({error:e.code||'INVALID'}));
 const s=await f.seed();await f.grade.completeJob(s.input);const job=await f.claim(),payload=f.result(job);
 await request(app).post(`/api/v1/internal/grading-jobs/vocabulary/${job.jobRef}/complete`).send(payload).expect(401);
 const {jobRef,...input}=payload;
 await request(app).post(`/api/v1/internal/grading-jobs/vocabulary/${jobRef}/complete`).set('Authorization','Bearer fixture-secret').send(input).expect(200);
 assert.equal((await f.row(s.id)).result_artifacts.vocabularyStatus,'available');
});
test('manual retry reuses the pinned model and prompt, is idempotent and keeps all gates',async t=>{
 const f=await fixture(t),s=await f.seed();await f.grade.completeJob(s.input);
 await f.query("UPDATE writing_practice.deferred_vocabulary_job SET status='failed',tries=3,error_code='SYNTHETIC_ERROR'");
 const app=express();app.use(express.json());installDeferredVocabularyRoutes(app,{pool:f.pool,config:{internalApiToken:'fixture-secret'},getSession:async ref=>({sessionRef:ref})});
 app.use((e,q,r,n)=>r.status(e.status||400).json({error:e.code||'INVALID'}));
 const retry=()=>request(app).post(`/api/v1/lesson9/sessions/${s.session}/vocabulary`).send({requestId:uuid(),retry:true});
 await retry().expect(202);await retry().expect(202);
 const job=await f.claim();assert.equal(job.modelId,model.modelId);assert.equal(job.thinkingLevel,'high');assert.equal(job.vocabularyPrompt,model.prompt);assert.match(job.operationKey,/:2:1$/);
 await f.query("UPDATE writing_practice.session_section SET locked=false WHERE session_id=$1 AND section_key='supporting_idea_1'",[s.session]);
 await retry().expect(409);
 assert.equal((await f.row(s.id)).feedback,s.input.feedback);
});
