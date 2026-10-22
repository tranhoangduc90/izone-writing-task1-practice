/**
 * Nhận identity đã xác thực từ route và dữ liệu có revision; ghi SQL theo chủ.
 * CAS ngăn nháp cũ ghi đè nháp mới. Bản gửi bất biến, kết quả về muộn không sửa nháp.
 * Mỗi callback cần lease đúng lượt; thiếu/sai chủ hoặc xung đột trả lỗi rõ.
 */
import { randomUUID } from 'node:crypto';
import { sha256, WebGradingError,reading67AnswerFingerprint } from './web-grader.js';
const emptyBody=()=>({answers:{},annotations:[],notes:'',flags:[]});
const values=s=>[s.ownerId,s.courseId,s.code,s.version];
const where='owner_id=$1 AND course_id=$2 AND assignment_code=$3 AND content_version=$4';
const canonical=value=>JSON.stringify(value,(_k,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);

export function createReading67WebStore({db,grader,homework}) {
  const gateFor=body=>grader.inspectWeb(body.answers||{});
  function draftView(row){const body=row?.body||emptyBody();return {body,runNo:row?.run_no||1,revision:row?.revision||0,savedAt:row?.saved_at||null,completeness:gateFor(body).completeness};}
  async function draft(scope){const r=await db.query(`SELECT * FROM reading_listening67.web_draft WHERE ${where}`,values(scope));return draftView(r.rows[0]);}
  async function save(scope,{baseRevision,mutationId,body}) {
    gateFor(body);
    const args=values(scope),requestHash=sha256(canonical({baseRevision,body}));
    return db.transaction(async tx=>{
      const previous=(await tx.query(`SELECT * FROM reading_listening67.web_mutation WHERE ${where} AND mutation_id=$5`,[...args,mutationId])).rows[0];
      if(previous){if(previous.request_hash!==requestHash)throw new WebGradingError('MUTATION_ID_REUSED',409);return previous.response;}
      await tx.query('INSERT INTO reading_listening67.web_draft(owner_id,course_id,assignment_code,content_version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',args);
      const row=(await tx.query(`SELECT * FROM reading_listening67.web_draft WHERE ${where} FOR UPDATE`,args)).rows[0];
      // PostgreSQL có thể chờ khóa: đọc lại receipt sau chờ để retry đồng thời trả đúng ACK.
      const replay=(await tx.query(`SELECT * FROM reading_listening67.web_mutation WHERE ${where} AND mutation_id=$5`,[...args,mutationId])).rows[0];
      if(replay){if(replay.request_hash!==requestHash)throw new WebGradingError('MUTATION_ID_REUSED',409);return replay.response;}
      if(row.revision!==baseRevision)throw new WebGradingError('DRAFT_REVISION_CONFLICT',409,{serverRevision:row.revision});
      const saved=(await tx.query(`UPDATE reading_listening67.web_draft SET body=$5::jsonb,revision=revision+1,saved_at=now() WHERE ${where} RETURNING *`,[...args,JSON.stringify(body)])).rows[0];
      const response=draftView(saved);
      await tx.query('INSERT INTO reading_listening67.web_mutation(owner_id,course_id,assignment_code,content_version,mutation_id,request_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[...args,mutationId,requestHash,JSON.stringify(response)]);
      if(homework)await homework.start(tx,scope);
      return response;
    });
  }
  async function submit(scope,{revision,requestId}) {
    const args=values(scope),requestHash=sha256(canonical({revision,grader:grader.pins.sha256}));
    return db.transaction(async tx=>{
      const old=(await tx.query(`SELECT * FROM reading_listening67.web_request WHERE ${where} AND request_id=$5`,[...args,requestId])).rows[0];
      if(old){if(old.request_hash!==requestHash)throw new WebGradingError('REQUEST_ID_REUSED',409);return attemptView(tx,scope,old.attempt_id,true);}
      const row=(await tx.query(`SELECT * FROM reading_listening67.web_draft WHERE ${where} FOR UPDATE`,args)).rows[0];
      const replay=(await tx.query(`SELECT * FROM reading_listening67.web_request WHERE ${where} AND request_id=$5`,[...args,requestId])).rows[0];
      if(replay){if(replay.request_hash!==requestHash)throw new WebGradingError('REQUEST_ID_REUSED',409);return attemptView(tx,scope,replay.attempt_id,true);}
      if(!row||row.revision!==revision)throw new WebGradingError('DRAFT_REVISION_CONFLICT',409,{serverRevision:row?.revision||0});
      const gate=gateFor(row.body);
      if(!gate.completeness.eligible_for_grading)throw new WebGradingError('BELOW_COMPLETION_THRESHOLD',422,gate.completeness);
      const inputHash=reading67AnswerFingerprint(gate.parsed);
      const cached=(await tx.query(`SELECT a.id,j.status FROM reading_listening67.web_attempt a JOIN reading_listening67.web_job j ON j.attempt_id=a.id WHERE a.owner_id=$1 AND a.course_id=$2 AND a.assignment_code=$3 AND a.content_version=$4 AND a.input_hash=$5 AND a.grader_hash=$6 AND j.status IN ('queued','processing','done','needs_review') ORDER BY a.created_at DESC LIMIT 1`,[...args,inputHash,grader.pins.sha256])).rows[0];
      if(cached?.status==='needs_review')throw new WebGradingError('PREVIOUS_GRADING_NEEDS_REVIEW',409);
      const attemptId=cached?.id||randomUUID();
      if(!cached){
        await tx.query('INSERT INTO reading_listening67.web_attempt(id,owner_id,course_id,assignment_code,content_version,draft_revision,snapshot,input_hash,grader_hash,completeness,run_no) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10::jsonb,$11)',[attemptId,...args,revision,JSON.stringify(row.body),inputHash,grader.pins.sha256,JSON.stringify(gate.completeness),row.run_no]);
        await tx.query("INSERT INTO reading_listening67.web_job(id,attempt_id,status) VALUES($1,$2,'queued')",[randomUUID(),attemptId]);
      }
      await tx.query('INSERT INTO reading_listening67.web_request(owner_id,course_id,assignment_code,content_version,request_id,request_hash,attempt_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[...args,requestId,requestHash,attemptId]);
      if(homework)await homework.submitted(tx,scope,attemptId);
      return attemptView(tx,scope,attemptId,!!cached);
    });
  }
  async function attemptView(executor,scope,attemptId,fromCache=false){
    const row=(await executor.query('SELECT a.*,j.id AS job_id,j.status,j.error_code,j.finished_at,r.data AS result FROM reading_listening67.web_attempt a JOIN reading_listening67.web_job j ON j.attempt_id=a.id LEFT JOIN reading_listening67.web_result r ON r.attempt_id=a.id WHERE a.id=$5 AND a.owner_id=$1 AND a.course_id=$2 AND a.assignment_code=$3 AND a.content_version=$4',[...values(scope),attemptId])).rows[0];
    if(!row)throw new WebGradingError('ATTEMPT_NOT_FOUND',404);
    return {attemptId:row.id,jobId:row.job_id,status:row.status,errorCode:row.error_code,createdAt:row.created_at,finishedAt:row.finished_at,runNo:row.run_no,draftRevision:row.draft_revision,snapshot:row.snapshot,completeness:row.completeness,result:row.status==='done'?row.result:null,graderHash:row.grader_hash,fromCache};
  }
  async function attempt(scope,id){return attemptView(db,scope,id);}
  async function history(scope){return (await db.query(`SELECT a.id AS "attemptId",a.run_no AS "runNo",a.draft_revision AS "draftRevision",a.created_at AS "createdAt",j.finished_at AS "finishedAt",j.status,j.error_code AS "errorCode",r.data->'grading'->'summary' AS summary FROM reading_listening67.web_attempt a JOIN reading_listening67.web_job j ON j.attempt_id=a.id LEFT JOIN reading_listening67.web_result r ON r.attempt_id=a.id WHERE a.owner_id=$1 AND a.course_id=$2 AND a.assignment_code=$3 AND a.content_version=$4 ORDER BY a.created_at DESC LIMIT 40`,values(scope))).rows;}
  // Reset lưu nguyên nháp cũ rồi mới mở lượt mới, cùng giao dịch và ID chống lặp.
  async function reset(scope,{baseRevision,mutationId}){return db.transaction(async tx=>{
    const args=values(scope),requestHash=sha256(canonical({operation:'reset',baseRevision}));
    const prior=(await tx.query(`SELECT * FROM reading_listening67.web_mutation WHERE ${where} AND mutation_id=$5`,[...args,mutationId])).rows[0];
    if(prior){if(prior.request_hash!==requestHash)throw new WebGradingError('MUTATION_ID_REUSED',409);return prior.response;}
    await tx.query('INSERT INTO reading_listening67.web_draft(owner_id,course_id,assignment_code,content_version) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',args);
    const row=(await tx.query(`SELECT * FROM reading_listening67.web_draft WHERE ${where} FOR UPDATE`,args)).rows[0];
    const replay=(await tx.query(`SELECT * FROM reading_listening67.web_mutation WHERE ${where} AND mutation_id=$5`,[...args,mutationId])).rows[0];
    if(replay){if(replay.request_hash!==requestHash)throw new WebGradingError('MUTATION_ID_REUSED',409);return replay.response;}
    if(!row||row.revision!==baseRevision)throw new WebGradingError('DRAFT_REVISION_CONFLICT',409);
    await tx.query('INSERT INTO reading_listening67.web_draft_archive(id,owner_id,course_id,assignment_code,content_version,run_no,revision,body,saved_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)',[randomUUID(),...args,row.run_no,row.revision,JSON.stringify(row.body),row.saved_at]);
    const next=(await tx.query(`UPDATE reading_listening67.web_draft SET body=$5::jsonb,revision=revision+1,run_no=run_no+1,saved_at=now() WHERE ${where} RETURNING *`,[...args,JSON.stringify(emptyBody())])).rows[0];
    const response=draftView(next);await tx.query('INSERT INTO reading_listening67.web_mutation(owner_id,course_id,assignment_code,content_version,mutation_id,request_hash,response) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',[...args,mutationId,requestHash,JSON.stringify(response)]);
    if(homework)await homework.start(tx,scope);return response;
  });}
  async function archives(scope){return (await db.query(`SELECT id,run_no AS "runNo",revision,body,saved_at AS "savedAt",archived_at AS "archivedAt" FROM reading_listening67.web_draft_archive WHERE ${where} ORDER BY archived_at DESC LIMIT 40`,values(scope))).rows;}
  async function firstCompleted(scope){return (await db.query(`SELECT a.id AS "attemptId",a.run_no AS "runNo",j.finished_at AS "finishedAt" FROM reading_listening67.web_attempt a JOIN reading_listening67.web_job j ON j.attempt_id=a.id WHERE a.owner_id=$1 AND a.course_id=$2 AND a.assignment_code=$3 AND a.content_version=$4 AND j.status='done' ORDER BY j.finished_at,a.id LIMIT 1`,values(scope))).rows[0]||null;}
  async function claim(){return db.transaction(async tx=>{
    const job=(await tx.query("SELECT * FROM reading_listening67.web_job WHERE status='queued' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0];
    if(!job)return null;
    const token=randomUUID();
    await tx.query("UPDATE reading_listening67.web_job SET status='processing',lease_token=$2,lease_until=now()+interval '15 minutes' WHERE id=$1",[job.id,token]);
    const a=(await tx.query('SELECT * FROM reading_listening67.web_attempt WHERE id=$1',[job.attempt_id])).rows[0];
    return {jobId:job.id,attemptId:a.id,leaseToken:token,answers:a.snapshot.answers,inputHash:a.input_hash,graderHash:a.grader_hash,ownerId:a.owner_id};
  });}
  async function assertOwner(tx,job){const row=(await tx.query("SELECT j.*,a.course_id,a.assignment_code,a.content_version FROM reading_listening67.web_job j JOIN reading_listening67.web_attempt a ON a.id=j.attempt_id WHERE j.id=$1 AND j.attempt_id=$2 AND j.lease_token=$3 AND a.owner_id=$4 AND j.status='processing' AND j.lease_until>now() FOR UPDATE OF j",[job.jobId,job.attemptId,job.leaseToken,job.ownerId])).rows[0];if(!row)throw new WebGradingError('JOB_LEASE_NOT_OWNED',409);return row;}
  async function recordProvider(job,response){return db.transaction(async tx=>{await assertOwner(tx,job);await tx.query('UPDATE reading_listening67.web_job SET provider_response=$2::jsonb WHERE id=$1',[job.jobId,JSON.stringify(response)]);});}
  async function finish(job,result){return db.transaction(async tx=>{
    const owned=await assertOwner(tx,job);
    const ids=result.grading?.target_results?.map(t=>t.target_id)||[];
    if(result.context?.operationId!==job.jobId||result.context?.sourceDigest!==job.inputHash||result.pins?.sha256!==job.graderHash||ids.length!==20||new Set(ids).size!==20||grader.profile.expected_target_ids.some(id=>!ids.includes(id)))throw new WebGradingError('RESULT_IDENTITY_MISMATCH',409);
    const {providerResponse:_private,...data}=result;
    await tx.query('INSERT INTO reading_listening67.web_result(attempt_id,data) VALUES($1,$2::jsonb)',[job.attemptId,JSON.stringify(data)]);
    await tx.query("UPDATE reading_listening67.web_job SET status='done',finished_at=now(),lease_until=NULL WHERE id=$1",[job.jobId]);
    if(homework)await homework.outcome(tx,{ownerId:job.ownerId,courseId:owned.course_id,code:owned.assignment_code,version:owned.content_version},job.jobId);
  });}
  async function fail(job,error){return db.transaction(async tx=>{const owned=await assertOwner(tx,job);const code=String(error.code||'GRADING_VALIDATION_FAILED').slice(0,100);const status=code==='AI_OUTCOME_UNKNOWN'?'needs_review':'failed';await tx.query('UPDATE reading_listening67.web_job SET status=$2,error_code=$3,finished_at=now(),lease_until=NULL WHERE id=$1',[job.jobId,status,code]);if(homework)await homework.outcome(tx,{ownerId:job.ownerId,courseId:owned.course_id,code:owned.assignment_code,version:owned.content_version},job.jobId);});}
  async function recoverExpired(){return db.transaction(async tx=>{
    const recovered=await tx.query("UPDATE reading_listening67.web_job SET status='needs_review',error_code='WORKER_LEASE_EXPIRED',finished_at=now() WHERE status='processing' AND lease_until<=now() RETURNING id,attempt_id");
    if(homework)for(const job of recovered.rows){const a=(await tx.query('SELECT * FROM reading_listening67.web_attempt WHERE id=$1',[job.attempt_id])).rows[0];await homework.outcome(tx,{ownerId:a.owner_id,courseId:a.course_id,code:a.assignment_code,version:a.content_version},job.id);}
    return recovered;
  });}
  return {draft,save,submit,attempt,history,archives,reset,firstCompleted,claim,recordProvider,finish,fail,recoverExpired};
}

export function createReading67WebWorker({store,grader,onError=()=>{}}){
  let running=null,timer=null,closed=false,lastRecovery=0;
  async function tick(){
    if(running||closed)return;
    running=(async()=>{if(Date.now()-lastRecovery>30000){await store.recoverExpired();lastRecovery=Date.now();}const job=await store.claim();if(!job)return;
      try{if(job.graderHash!==grader.pins.sha256)throw new WebGradingError('GRADER_PIN_MISMATCH',503);const prepared=grader.prepareWeb(job.answers,job.jobId);const result=await grader.finish(prepared,{onProviderResponse:r=>store.recordProvider(job,r)});await store.finish(job,result);}
      catch(error){try{await store.fail(job,error);}catch(storeError){onError(storeError);}onError(error);}
    })();
    try{await running;}catch(error){onError(error);}finally{running=null;}
  }
  return {tick,start(){if(!timer){timer=setInterval(tick,750);timer.unref();tick();}},async close(){closed=true;clearInterval(timer);await running;}};
}
