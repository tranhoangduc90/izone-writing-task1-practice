import assert from 'node:assert/strict';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {readQueueStatus} from '../ops/sw-task2-production/queue-status.mjs';
import {createWritingPracticeService} from '../ops/sw-task2-production/service-runtime.js';
import {createShopsResults} from '../ops/sw-task2-production/atomic-results.mjs';

test('Shops queue counts only real queued Task 2 attempts and signals both kinds of recovery',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(`
  CREATE SCHEMA writing_practice;
  SET search_path TO writing_practice,public;
  CREATE TABLE activity(id int,grading_pool text);
  CREATE TABLE activity_session(id int,activity_id int);
  CREATE TABLE check_attempt(id int,session_id int,status text,lease_expires_at timestamptz);
  CREATE TABLE comment(attempt_id int,status text);
  CREATE TABLE grading_dispatch(attempt_id int,status text);
  INSERT INTO activity VALUES(1,'task2'),(2,'task1');
  INSERT INTO activity_session VALUES(1,1),(2,2);
  INSERT INTO check_attempt VALUES(1,1,'queued',null),(2,2,'queued',null),
    (3,1,'completed',null),(4,1,'leased',now()+interval '1 hour'),(5,1,'failed',null);
  INSERT INTO grading_dispatch VALUES(3,'pending');
  INSERT INTO comment VALUES(3,'queued'),(5,'technical_error');
 `);
 let reads=0;
 const pool={query(...args){reads++;return db.query(...args);}};
 const initial=await readQueueStatus(pool,true);
 assert.equal(reads,1);
 assert.equal(initial.queued,1);
 assert.equal(initial.recoverDue,false);
 await db.exec("UPDATE check_attempt SET lease_expires_at=now()-interval '1 second' WHERE id=4");
 assert.equal((await readQueueStatus(pool,true)).recoverDue,true);
 await db.exec("UPDATE check_attempt SET status='queued' WHERE id=4; UPDATE comment SET status='queued' WHERE attempt_id=5");
 assert.deepEqual(await readQueueStatus(pool,true),{database:initial.database,queued:2,recoverDue:true});
 assert.deepEqual(await readQueueStatus(pool),{database:initial.database,queued:2});
 await db.exec("UPDATE comment SET status='technical_error' WHERE attempt_id=5");
 assert.deepEqual(await readQueueStatus(pool,true),{database:initial.database,queued:2,recoverDue:false});
});

test('Shops recovers the same attempt after a writer outage, rejects the old lease and reads the pinned result',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 const attempt='10000000-0000-4000-8000-000000000001',session='10000000-0000-4000-8000-000000000002';
 const oldLease='10000000-0000-4000-8000-000000000003',group='a'.repeat(48);
 await db.exec(`
  CREATE SCHEMA writing_practice;
  SET search_path TO writing_practice,public;
  CREATE TABLE activity(id int,grading_pool text);
  CREATE TABLE activity_session(id int,activity_id int,public_id uuid);
  CREATE TABLE check_attempt(id int,public_id uuid,session_id int,section_key text,status text,
    comment_number int,snapshot jsonb,grading_context jsonb,created_at timestamptz,
    retry_count int,worker_id text,lease_token uuid,lease_expires_at timestamptz,
    version int,updated_at timestamptz,result_status text,feedback text,result_artifacts jsonb,
    grading_meta jsonb,error_code text,completed_at timestamptz,round_number int,body_hash text,late_callback_token uuid);
  CREATE TABLE comment(attempt_id int,status text,content text);
  CREATE TABLE session_section(session_id int,section_key text,locked boolean,fail_streak int,updated_at timestamptz);
  CREATE FUNCTION writing_practice.task2_grading_context(int,text) RETURNS jsonb LANGUAGE SQL AS $$SELECT '{}'::jsonb$$;
  INSERT INTO activity VALUES(1,'task2');
  INSERT INTO activity_session VALUES(1,1,'${session}');
  INSERT INTO check_attempt (id,public_id,session_id,section_key,status,comment_number,snapshot,grading_context,
    created_at,retry_count,worker_id,lease_token,lease_expires_at,version,updated_at)
   VALUES(1,'${attempt}',1,'draft','leased',1,'{"draft2":"Synthetic draft"}','{"activitySlug":"fixture"}',
    now()-interval '2 minutes',1,'previous','${oldLease}',now()-interval '1 second',1,now());
  INSERT INTO comment VALUES(1,'queued','waiting');
  INSERT INTO session_section VALUES(1,'draft',false,0,now());
 `);
 const query=async(...args)=>{const r=await db.query(...args);return {...r,rowCount:r.rows.length||r.affectedRows||0};};
 const pool={query,connect:async()=>({query,release(){}})};
 const service=createWritingPracticeService({pool});
 let writerUnavailable=true;
 const result=createShopsResults({pool,fetchImpl:async url=>{
  assert.equal(url,`http://shops-writing-writer:8780/writing-data/${group}/v000002.json`);
  if(writerUnavailable)return new Response(null,{status:503});
  return new Response(JSON.stringify({meta:{id:group,version:2},essays:[]}));
 }});
 const artifacts={gradingEngine:'sw-task2-writing56-67-production-20261025.1',writerGroupId:group,writerVersion:2,
  readbackOk:true,noCorrections:true,correctionsCount:0,
  lmsUrl:`https://ducizone.ddns.net/shops-writing-api/results/shared/writing-essays/${group}/view?v=2`};
 await assert.rejects(result.byCapability(group,2),e=>e.code==='NOT_FOUND');
 assert.equal((await readQueueStatus(pool,true)).recoverDue,true);
 assert.deepEqual(await service.recoverJobs(),[{attemptRef:attempt,status:'queued',canRetry:false}]);
 const [job]=await service.claimJobs({workerId:'current',maxJobs:1,leaseSeconds:420,workerPool:'task2'});
 assert.equal(job.jobRef,attempt);
 assert.equal(job.snapshot.draft2,'Synthetic draft');
 const completion={jobRef:attempt,resultStatus:'passed',feedback:'fixture',artifacts};
 await assert.rejects(service.completeJob({...completion,leaseToken:oldLease}),e=>e.code==='LEASE_NOT_OWNED');
 await assert.rejects(service.completeJob({...completion,leaseToken:job.leaseToken,artifacts:{}}),e=>e.code==='DRAFT_LMS_RESULT_REQUIRED');
 assert.equal((await query('SELECT status FROM check_attempt')).rows[0].status,'leased');
 await service.completeJob({...completion,leaseToken:job.leaseToken});
 await assert.rejects(result.getDraftResult({sessionRef:session}),e=>e.code==='SHOPS_RESULT_UNAVAILABLE');
 writerUnavailable=false;
 assert.equal((await result.getDraftResult({sessionRef:session})).readbackOk,true);
 assert.equal((await query('SELECT count(*)::int n FROM comment WHERE status=\'completed\'')).rows[0].n,1);
 assert.equal((await readQueueStatus(pool,true)).recoverDue,false);
});
