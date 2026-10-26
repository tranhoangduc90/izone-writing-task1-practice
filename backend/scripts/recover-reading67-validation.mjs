/** Phục hồi một job lỗi từ phản hồi đã lưu. Không đổi bản nộp/nháp/hash hoặc tạo lượt làm mới. */
import fs from 'node:fs/promises';import {randomUUID} from 'node:crypto';
import {loadReading67WebGrader,reading67AnswerFingerprint} from '../src/reading-listening67/web-grader.js';
import {createReading67Postgres} from '../src/reading-listening67/web-postgres.js';
const [configPath,attemptId,...flags]=process.argv.slice(2);
if(!configPath||!/^[0-9a-f-]{36}$/.test(attemptId||''))throw Error('RECOVERY_ARGUMENTS_REQUIRED');
const config=JSON.parse(await fs.readFile(configPath,'utf8'));
if(config.gradingValidation?.enabled!==true)throw Error('VALIDATION_NOT_ENABLED');
const grader=await loadReading67WebGrader({snapshotPath:config.graderPath,expectedSha256:config.graderSha256,validation:true});
const content=JSON.parse(await fs.readFile(config.contentPath,'utf8'));
const db=createReading67Postgres({connectionString:(await fs.readFile(config.database.connectionFile,'utf8')).trim()});
try{
 const result=await db.transaction(async tx=>{
  const row=(await tx.query('SELECT a.*,row_to_json(j) AS job FROM reading_listening67.web_attempt a JOIN reading_listening67.web_job j ON j.attempt_id=a.id WHERE a.id=$1 FOR UPDATE OF j',[attemptId])).rows[0];
  if(!row)throw Error('ATTEMPT_NOT_FOUND');
  if(row.assignment_code!==content.code||row.content_version!==content.version||!config.allowedClassIds.includes(row.course_id)||row.grader_hash!==grader.pins.sha256)throw Error('RECOVERY_IDENTITY_MISMATCH');
  if(reading67AnswerFingerprint(grader.parseWeb(row.snapshot.answers))!==row.input_hash)throw Error('RECOVERY_INPUT_HASH_MISMATCH');
  const already=(await tx.query("SELECT id FROM reading_listening67.web_validation_event WHERE job_id=$1 AND kind='recovery_started' LIMIT 1",[row.job.id])).rows[0];
  if(already)return {outcome:'already_requested',attemptId,status:row.job.status};
  if(row.job.status!=='failed'||row.job.error_code!=='GRADING_VALIDATION_FAILED'||!row.job.provider_response)throw Error('RECOVERY_NOT_ELIGIBLE');
  if((await tx.query('SELECT 1 FROM reading_listening67.web_result WHERE attempt_id=$1',[attemptId])).rows.length)throw Error('RESULT_ALREADY_EXISTS');
  if(!flags.includes('--apply'))return {outcome:'preview',attemptId,status:row.job.status,inputHash:row.input_hash,graderHash:row.grader_hash};
  await tx.query('INSERT INTO reading_listening67.web_validation_event(id,job_id,kind,data) VALUES($1,$2,$3,$4::jsonb)',[randomUUID(),row.job.id,'recovery_started',JSON.stringify({previous:row.job,inputHash:row.input_hash,graderHash:row.grader_hash,validationVersion:grader.validationVersion})]);
  await tx.query("INSERT INTO reading_listening67.web_validation(job_id,state) VALUES($1,$2::jsonb)",[row.job.id,JSON.stringify({version:grader.validationVersion,round:0,phase:'initial',issues:[]})]);
  await tx.query("UPDATE reading_listening67.web_job SET status='queued',error_code=NULL,finished_at=NULL,lease_token=NULL,lease_until=NULL WHERE id=$1",[row.job.id]);
  return {outcome:'queued',attemptId,originalFailurePreserved:true};
 });console.log(JSON.stringify(result));
}finally{await db.close();}
