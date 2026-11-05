import crypto from 'node:crypto';
import {z} from 'zod';
import {ApiError} from '../../src/service.js';
import {withTransaction} from '../../src/db.js';
import {vocabularyHash,normalizeVocabulary} from './lesson9-vocabulary.js';

const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'
 ?Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k])])):value;
export const completionHash=value=>crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const taskSchema=z.object({prompt:z.string().min(1).max(120000),modelId:z.literal('gemini-3.1-pro-preview'),thinkingLevel:z.literal('high')}).strict();
const fail=(code,status=409)=>new ApiError(status,code,'Công việc từ vựng không còn hợp lệ với lượt chấm này.');

export async function vocabularyCompletionReplay(client,input){
 if(!input.rawModelMeta?.deferredVocabulary)return null;
 const found=await client.query(`SELECT j.completion_hash,j.completion_receipt FROM writing_practice.deferred_vocabulary_job j
  WHERE j.source_attempt_ref=$1 AND j.source_lease_token=$2`,[input.jobRef,input.leaseToken]);
 if(!found.rowCount)return null;
 if(found.rows[0].completion_hash!==completionHash(input))throw fail('VOCABULARY_COMPLETION_MISMATCH');
 return {...found.rows[0].completion_receipt,idempotent:true};
}

// Called inside the SAME transaction that publishes feedback and locks the section.
export async function enqueueVocabulary(client,row,input){
 const raw=input.rawModelMeta?.deferredVocabulary;
 if(!raw)return null;
 if(row.section_key!=='supporting_idea_2'||input.resultStatus!=='passed')throw fail('VOCABULARY_SOURCE_NOT_PASSED',400);
 const task=taskSchema.parse(raw);
 const source=(await client.query(`SELECT a.snapshot,a.round_number,a.grading_context,s.response_data
  FROM writing_practice.check_attempt a JOIN writing_practice.activity_session s ON s.id=a.session_id WHERE a.id=$1`,[row.id])).rows[0];
 if(!source||!['body1','body2'].includes(source.snapshot.body_choice))throw fail('VOCABULARY_SOURCE_INVALID',400);
 const inserted=await client.query(`INSERT INTO writing_practice.deferred_vocabulary_job
  (attempt_id,session_id,round_number,source_lease_token,source_attempt_ref,completion_hash,snapshot_hash,input)
  VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING public_id`,[row.id,row.session_id,source.round_number,input.leaseToken,input.jobRef,
  completionHash(input),vocabularyHash(source.snapshot),JSON.stringify({...task,studentInput:source.snapshot,
   bodyKey:source.snapshot.body_choice,promptVersion:source.grading_context?.promptVersion||null})]);
 return inserted.rows[0].public_id;
}

export async function rememberVocabularyReceipt(client,ref,receipt){
 if(ref)await client.query('UPDATE writing_practice.deferred_vocabulary_job SET completion_receipt=$2::jsonb WHERE public_id=$1',[ref,JSON.stringify(receipt)]);
}

async function setOutcome(client,job,status,errorCode=null){
 await client.query(`UPDATE writing_practice.deferred_vocabulary_job SET status=$2,error_code=$3,
  lease_token=NULL,lease_until=NULL,updated_at=now() WHERE public_id=$1`,[job.public_id,status,errorCode]);
 if(status!=='queued')await client.query(`UPDATE writing_practice.check_attempt SET result_artifacts=
  result_artifacts||jsonb_build_object('vocabularyStatus','unavailable','vocabularyError',$2::text),
  version=version+1,updated_at=now() WHERE id=$1`,[job.attempt_id,errorCode]);
}

async function stillCurrent(client,job){
 const source=await client.query(`SELECT s.response_data,ss.round_number,a.public_id
  FROM writing_practice.activity_session s JOIN writing_practice.session_section ss
   ON ss.session_id=s.id AND ss.section_key='supporting_idea_2'
  JOIN writing_practice.check_attempt a ON a.id=$2
  WHERE s.id=$1 AND a.status='completed' AND a.result_status='passed'
   AND a.round_number=ss.round_number AND ss.locked
   AND NOT EXISTS(SELECT 1 FROM writing_practice.check_attempt newer
     WHERE newer.session_id=s.id AND newer.section_key='supporting_idea_2'
      AND newer.created_at>a.created_at)
  FOR UPDATE OF s`,[job.session_id,job.attempt_id]);
 return source.rowCount===1&&source.rows[0].round_number===job.round_number
  &&vocabularyHash(source.rows[0].response_data)===job.snapshot_hash;
}

export async function claimVocabulary(client,{workerId,leaseSeconds=420}){
 // FIFO across grading and vocabulary; the existing worker keeps its two slots.
 const found=await client.query(`SELECT j.* FROM writing_practice.deferred_vocabulary_job j
  WHERE j.status='queued' AND j.tries<3 AND j.next_attempt_at<=now()
   AND j.created_at<=COALESCE((SELECT min(a.created_at) FROM writing_practice.check_attempt a
    JOIN writing_practice.activity_session s ON s.id=a.session_id JOIN writing_practice.activity t ON t.id=s.activity_id
    WHERE a.status='queued' AND a.retry_count<3 AND t.grading_pool='task2'),'infinity'::timestamptz)
  ORDER BY j.created_at,j.public_id FOR UPDATE OF j SKIP LOCKED LIMIT 1`);
 if(!found.rowCount)return null;
 const job=found.rows[0];
 if(!await stillCurrent(client,job)){await setOutcome(client,job,'superseded','VOCABULARY_CONTENT_CHANGED');return null;}
 const {rows:[lease]}=await client.query(`UPDATE writing_practice.deferred_vocabulary_job
  SET status='leased',tries=tries+1,lease_token=gen_random_uuid(),lease_until=now()+($2::text||' seconds')::interval,
   updated_at=now() WHERE public_id=$1 RETURNING lease_token,lease_until,tries,generation`,[job.public_id,leaseSeconds]);
 return {kind:'vocabulary',jobRef:job.public_id,attemptRef:job.public_id,sourceAttemptRef:(await client.query('SELECT public_id FROM writing_practice.check_attempt WHERE id=$1',[job.attempt_id])).rows[0].public_id,
  leaseToken:lease.lease_token,leaseExpiresAt:lease.lease_until,workerPool:'task2',workerId,
  ...job.input,vocabularyPrompt:job.input.prompt,
  operationKey:`sw-task2-vocabulary:${job.public_id}:${lease.generation}:${lease.tries}`};
}

export async function recoverVocabulary(client){
 const expired=await client.query(`SELECT * FROM writing_practice.deferred_vocabulary_job
  WHERE status='leased' AND lease_until<=now() FOR UPDATE SKIP LOCKED`);
 for(const job of expired.rows){
  const terminal=job.tries>=3;
  await setOutcome(client,job,terminal?'failed':'queued','VOCABULARY_TIMEOUT');
  if(!terminal)await client.query("UPDATE writing_practice.deferred_vocabulary_job SET next_attempt_at=now()+interval '5 seconds' WHERE public_id=$1",[job.public_id]);
 }
 return expired.rowCount;
}

export function createDeferredVocabularyService({pool}){
 async function complete({jobRef,leaseToken,artifacts,rawModelMeta={}}){
  const responseHash=completionHash({artifacts,rawModelMeta});
  return withTransaction(pool,async client=>{
   const found=await client.query('SELECT * FROM writing_practice.deferred_vocabulary_job WHERE public_id=$1 FOR UPDATE',[jobRef]);
   const job=found.rows[0];
   if(!job||job.lease_token!==leaseToken)throw fail('LEASE_NOT_OWNED');
   if(job.status==='completed'){
    if(job.response_hash!==responseHash)throw fail('VOCABULARY_RESULT_MISMATCH');
    return {jobRef,status:'completed',idempotent:true};
   }
   if(job.status!=='leased'||new Date(job.lease_until).getTime()<=Date.now())throw fail('LEASE_NOT_OWNED');
   if(!await stillCurrent(client,job)){await setOutcome(client,job,'superseded','VOCABULARY_CONTENT_CHANGED');return {jobRef,status:'superseded'};}
   if(artifacts?.bodyKey!==job.input.bodyKey||artifacts?.vocabularyStatus!=='available'
    ||rawModelMeta.modelId!==job.input.modelId||rawModelMeta.thinkingLevel!==job.input.thinkingLevel)throw fail('VOCABULARY_RESULT_INVALID',400);
   normalizeVocabulary(artifacts.vocabulary);
   // Keep feedback, pass/needs-revision, fail streak and all step locks unchanged.
   await client.query(`UPDATE writing_practice.check_attempt SET result_artifacts=result_artifacts||$2::jsonb,
    grading_meta=grading_meta||jsonb_build_object('vocabulary',$3::jsonb),version=version+1,updated_at=now()
    WHERE id=$1`,[job.attempt_id,JSON.stringify({...artifacts,vocabularyJobRef:jobRef}),JSON.stringify(rawModelMeta)]);
   // Retain the final lease token to authenticate an identical lost-ACK replay.
   await client.query(`UPDATE writing_practice.deferred_vocabulary_job SET status='completed',response_hash=$2,
    error_code=NULL,lease_until=NULL,updated_at=now() WHERE public_id=$1`,[jobRef,responseHash]);
   return {jobRef,status:'completed'};
  });
 }
 async function failed({jobRef,leaseToken,errorCode}){
  return withTransaction(pool,async client=>{
   const {rows:[job]}=await client.query("SELECT * FROM writing_practice.deferred_vocabulary_job WHERE public_id=$1 AND lease_token=$2 AND status='leased' AND lease_until>now() FOR UPDATE",[jobRef,leaseToken]);
   if(!job)throw fail('LEASE_NOT_OWNED');
   if(!await stillCurrent(client,job)){await setOutcome(client,job,'superseded','VOCABULARY_CONTENT_CHANGED');return {jobRef,status:'superseded'};}
   const status=job.tries>=3?'failed':'queued';
   await setOutcome(client,job,status,errorCode);
   if(status==='queued')await client.query("UPDATE writing_practice.deferred_vocabulary_job SET next_attempt_at=now()+($2::text||' seconds')::interval WHERE public_id=$1",[jobRef,job.tries===1?5:15]);
   return {jobRef,status};
  });
 }
 return {complete,failed};
}

export async function deferredQueueStatus(pool,includeRecovery){
 const {rows:[row]}=await pool.query(`SELECT current_database() AS database,
  ((SELECT count(*) FROM writing_practice.check_attempt a JOIN writing_practice.activity_session s ON s.id=a.session_id
   JOIN writing_practice.activity t ON t.id=s.activity_id WHERE a.status='queued' AND t.grading_pool='task2')+
   (SELECT count(*) FROM writing_practice.deferred_vocabulary_job WHERE status='queued' AND next_attempt_at<=now())) AS queued,
  CASE WHEN $1::boolean THEN (
   EXISTS(SELECT 1 FROM writing_practice.check_attempt WHERE status='leased' AND lease_expires_at<=now()) OR
   EXISTS(SELECT 1 FROM writing_practice.comment c JOIN writing_practice.check_attempt a ON a.id=c.attempt_id WHERE c.status='queued' AND a.status='failed') OR
   EXISTS(SELECT 1 FROM writing_practice.deferred_vocabulary_job WHERE status='leased' AND lease_until<=now())) END AS "recoverDue"`,[includeRecovery]);
 return {database:row.database,queued:Number(row.queued),...(includeRecovery?{recoverDue:row.recoverDue}:{})};
}

export function installDeferredVocabularyRoutes(app,{pool,config,getSession}){
 const service=createDeferredVocabularyService({pool});
 const authorized=q=>{const actual=Buffer.from((q.get('authorization')||'').replace(/^Bearer\s+/i,'')),expected=Buffer.from(config.internalApiToken);return actual.length===expected.length&&crypto.timingSafeEqual(actual,expected);};
 const internal=(q,r,next)=>authorized(q)?next():r.status(401).json({ok:false,error:'UNAUTHORIZED'});
 const safe=fn=>(q,r,next)=>Promise.resolve(fn(q,r)).catch(next);
 app.get('/api/v1/shops/status',safe(async(q,r)=>r.json({ok:true,environment:'production',aiMode:'n8n-task2-connected',...await deferredQueueStatus(pool,authorized(q))})));
 if(getSession)app.post('/api/v1/lesson9/sessions/:ref/vocabulary',safe(async(q,r,next)=>{
  const ref=z.uuid().parse(q.params.ref);
  z.object({requestId:z.uuid(),retry:z.boolean().optional()}).parse(q.body);
  const handled=await withTransaction(pool,async client=>{
   const {rows:[job]}=await client.query(`SELECT j.* FROM writing_practice.deferred_vocabulary_job j
    JOIN writing_practice.activity_session s ON s.id=j.session_id WHERE s.public_id=$1
    ORDER BY j.created_at DESC LIMIT 1 FOR UPDATE OF j`,[ref]);
   if(!job||!await stillCurrent(client,job))return false;
   const gates=await client.query("SELECT 1 FROM writing_practice.session_section WHERE session_id=$1 AND section_key=ANY($2::text[]) AND locked",[job.session_id,['topic_sentence','supporting_idea_1','supporting_idea_2']]);
   if(gates.rowCount!==3)throw fail('VOCABULARY_NOT_READY');
   if(['failed','superseded'].includes(job.status)){
    await client.query(`UPDATE writing_practice.deferred_vocabulary_job SET status='queued',tries=0,generation=generation+1,
     lease_token=NULL,lease_until=NULL,error_code=NULL,next_attempt_at=now(),updated_at=now() WHERE public_id=$1`,[job.public_id]);
    await client.query("UPDATE writing_practice.check_attempt SET result_artifacts=result_artifacts||'{\"vocabularyStatus\":\"pending\"}'::jsonb,version=version+1,updated_at=now() WHERE id=$1",[job.attempt_id]);
   }
   return true;
  });
  if(!handled)return next();
  r.status(202).json({ok:true,session:await getSession(ref)});
 }));
 const base='/api/v1/internal/grading-jobs/vocabulary/:ref/';
 app.post(base+'complete',internal,safe(async(q,r)=>{
  const input=z.object({leaseToken:z.uuid(),artifacts:z.record(z.string(),z.unknown()),rawModelMeta:z.record(z.string(),z.unknown()).optional()}).strict().parse(q.body);
  r.json({ok:true,job:await service.complete({jobRef:z.uuid().parse(q.params.ref),...input})});
 }));
 app.post(base+'fail',internal,safe(async(q,r)=>{
  const input=z.object({leaseToken:z.uuid(),errorCode:z.string().min(1).max(100)}).strict().parse(q.body);
  r.json({ok:true,job:await service.failed({jobRef:z.uuid().parse(q.params.ref),...input})});
 }));
}
