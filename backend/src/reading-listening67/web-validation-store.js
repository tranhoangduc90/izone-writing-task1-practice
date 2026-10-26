/** Lưu intent/response/checkpoint có lease; tiến trình khác không được hoàn tất hoặc ghi đè. */
import {randomUUID} from 'node:crypto';
export function createValidationStore({db,assertOwner}){
  const owned=(job,fn)=>db.transaction(async tx=>{await assertOwner(tx,job);return fn(tx);});
  async function load(job){return owned(job,async tx=>{
    const state=(await tx.query('SELECT state FROM reading_listening67.web_validation WHERE job_id=$1',[job.jobId])).rows[0]?.state;
    const unfinished=(await tx.query("SELECT call_id,status FROM reading_listening67.web_validation_round WHERE job_id=$1 AND status IN ('calling','unknown') ORDER BY created_at DESC LIMIT 1",[job.jobId])).rows[0];
    // Khi response đã lưu nhưng checkpoint chưa lưu, worker phát lại đúng response; không gọi AI mới.
    const received=(await tx.query("SELECT * FROM reading_listening67.web_validation_round WHERE job_id=$1 AND status='received' ORDER BY created_at DESC LIMIT 1",[job.jobId])).rows[0];
    return {state,unfinished,received};
  });}
  async function checkpoint(job,state){return owned(job,async tx=>{
    await tx.query('INSERT INTO reading_listening67.web_validation(job_id,state) VALUES($1,$2::jsonb) ON CONFLICT(job_id) DO UPDATE SET state=$2::jsonb,updated_at=now()',[job.jobId,JSON.stringify(state)]);
    if(state.lastCallId)await tx.query("UPDATE reading_listening67.web_validation_round SET status='applied' WHERE call_id=$1 AND job_id=$2 AND status='received'",[state.lastCallId,job.jobId]);
  });}
  async function round(job,event){return owned(job,async tx=>{
    if(event.status==='calling')await tx.query("INSERT INTO reading_listening67.web_validation_round(call_id,job_id,phase,round_no,status,prompt_hash,metadata) VALUES($1,$2,$3,$4,'calling',$5,$6::jsonb)",[event.callId,job.jobId,event.phase,event.round,event.promptHash,JSON.stringify({validationVersion:event.validationVersion})]);
    else{const changed=await tx.query('UPDATE reading_listening67.web_validation_round SET status=$3,response=$4::jsonb,metadata=metadata||$5::jsonb,finished_at=now() WHERE call_id=$1 AND job_id=$2 AND status=\'calling\' RETURNING call_id',[event.callId,job.jobId,event.status,JSON.stringify(event.response||null),JSON.stringify({usage:event.usage,errorCode:event.errorCode})]);if(changed.rows.length!==1)throw Object.assign(Error('JOB_ROUND_NOT_OWNED'),{code:'JOB_ROUND_NOT_OWNED'});}
  });}
  async function defer(job,error){return owned(job,async tx=>{
    const state=error.details.state;
    const seconds=Math.min(3600,state.round>3?30*2**Math.min(7,state.round-4):1);
    await tx.query('UPDATE reading_listening67.web_validation SET next_attempt_at=now()+($2::int*interval \'1 second\'),updated_at=now() WHERE job_id=$1',[job.jobId,seconds]);
    await tx.query("UPDATE reading_listening67.web_job SET status='queued',error_code=NULL,lease_until=NULL,lease_token=NULL WHERE id=$1",[job.jobId]);
    await tx.query('INSERT INTO reading_listening67.web_validation_event(id,job_id,kind,data) VALUES($1,$2,$3,$4::jsonb)',[randomUUID(),job.jobId,'validation_pending',JSON.stringify({phase:state.phase,round:state.round,issues:state.issues,nextInSeconds:seconds})]);
  });}
  return {load,checkpoint,round,defer};
}
