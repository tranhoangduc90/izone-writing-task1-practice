/**
 * Nhận sự kiện đã lưu trong transaction bài, xếp hàng Docs riêng không gọi Google.
 * Worker kiểm lại chủ, khóa revision và đọc lại. Thiếu Homework chờ vô hạn theo
 * nhịp 5 phút; lỗi sai chủ/mã hoặc sửa tay giữ blocked, không ghi sang đích khác.
 */
import {randomUUID} from 'node:crypto';
import {WebGradingError} from './web-grader.js';
import {planReading67HomeworkWrite} from './web-homework-docs.js';
import {reading67ResultSummary,reading67ProgressText} from './web-result-summary.js';
const args=s=>[s.ownerId,s.courseId,s.code,s.version];
const clause='owner_id=$1 AND course_id=$2 AND assignment_code=$3 AND content_version=$4';
const fail=(code,status=409)=>{throw new WebGradingError(code,status);};
const scopeFor=b=>({ownerId:b.owner_id,courseId:b.course_id,code:b.assignment_code,version:b.content_version});

export function createReading67Homework({db,metadata,pageBase,owner,docs,clock=Date.now,planWrite=planReading67HomeworkWrite,resultSummary=reading67ResultSummary,progressText=reading67ProgressText,completionText}){
 const page=new URL(pageBase);if(page.protocol!=='https:')throw Error('HTTPS_PAGE_BASE_REQUIRED');
 page.searchParams.set('server','1');page.searchParams.set('assignmentCode',metadata.code);
 const entryUrl=page.href;
 function teacherUrl(s,attemptId){const url=new URL(entryUrl);url.searchParams.set('teacher','1');url.searchParams.set('classId',s.courseId);url.searchParams.set('studentRef',s.ownerId);if(attemptId)url.searchParams.set('attemptId',attemptId);return url.href;}
 async function ensure(tx,s){
  if(s.code!==metadata.code||s.version!==metadata.version)fail('DOC_CODE_MISMATCH');
  await tx.query('INSERT INTO reading_listening67.web_homework_binding(id,owner_id,course_id,assignment_code,content_version) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',[randomUUID(),...args(s)]);
  const b=(await tx.query('SELECT * FROM reading_listening67.web_homework_binding WHERE '+clause+' FOR UPDATE',args(s))).rows[0];
  await append(tx,b,'cta','cta',{url:entryUrl,code:s.code,version:s.version});
  return b;
 }
 async function append(tx,b,key,kind,payload){
  const old=(await tx.query('SELECT * FROM reading_listening67.web_homework_job WHERE binding_id=$1 AND event_key=$2',[b.id,key])).rows[0];if(old)return old;
  const sequence=kind==='cta'?0:b.sequence+1;
  if(kind!=='cta')await tx.query('UPDATE reading_listening67.web_homework_binding SET sequence=$2 WHERE id=$1',[b.id,sequence]);
  return (await tx.query('INSERT INTO reading_listening67.web_homework_job(id,binding_id,event_key,sequence,kind,payload) VALUES($1,$2,$3,$4,$5,$6::jsonb) RETURNING *',[randomUUID(),b.id,key,sequence,kind,JSON.stringify(payload)])).rows[0];
 }
 async function state(tx,s,b){
  const draft=(await tx.query('SELECT run_no,revision FROM reading_listening67.web_draft WHERE '+clause,args(s))).rows[0];
  const no=draft?.run_no||1;
  let attempt;
  if(b.selected_run_no===no&&b.selected_attempt_id)attempt=(await tx.query('SELECT a.id,a.run_no,j.status FROM reading_listening67.web_attempt a JOIN reading_listening67.web_job j ON j.attempt_id=a.id WHERE a.id=$1 AND a.owner_id=$2 AND a.course_id=$3 AND a.assignment_code=$4 AND a.content_version=$5',[b.selected_attempt_id,...args(s)])).rows[0];
  else attempt=(await tx.query('SELECT a.id,a.run_no,j.status FROM reading_listening67.web_attempt a JOIN reading_listening67.web_job j ON j.attempt_id=a.id WHERE a.owner_id=$1 AND a.course_id=$2 AND a.assignment_code=$3 AND a.content_version=$4 AND a.run_no=$5 ORDER BY a.draft_revision DESC,a.created_at DESC LIMIT 1',[...args(s),no])).rows[0];
  const first=(await tx.query("SELECT a.run_no FROM reading_listening67.web_attempt a JOIN reading_listening67.web_job j ON j.attempt_id=a.id WHERE a.owner_id=$1 AND a.course_id=$2 AND a.assignment_code=$3 AND a.content_version=$4 AND j.status='done' ORDER BY j.finished_at,a.id LIMIT 1",args(s))).rows[0]?.run_no;
  let text=no===1?'Đã bắt đầu làm bài lần đầu tiên.':`Đã bắt đầu làm bài số ${no} (đã reset ${no-1} lần).`;
  if(attempt?.status==='done'){
   text=no===1?'Đã hoàn thành ngay từ lần đầu.':first&&first!==no?`Đã hoàn thành lượt luyện lại số ${no} (tổng ${no-1} lần reset). Lần hoàn thành đầu tiên: lượt ${first}.`:`Đã hoàn thành sau ${no-1} lần reset (lần làm bài số ${no}).`;
   const saved=(await tx.query('SELECT data FROM reading_listening67.web_result WHERE attempt_id=$1',[attempt.id])).rows[0];
   const progress=resultSummary(saved?.data);
   if(completionText)text=completionText({runNo:no,firstRunNo:first,progress});
   text+=progressText(progress);
   text+=' Giảng viên nhấn vào đây để xem kết quả.';
  }else if(attempt){
   text=['queued','processing'].includes(attempt.status)?`Đã nộp bài lần ${no}, đang chờ chấm. Giảng viên nhấn vào đây để xem bài đã nộp.`:`Bài lần ${no} đã được lưu, chưa có kết quả chấm. Giảng viên nhấn vào đây để xem bài đã nộp.`;
  }
  return {text,link:attempt?teacherUrl(s,attempt.id):'',runNo:no,attemptId:attempt?.id||null,code:s.code,version:s.version};
 }
 async function start(tx,s){
  const b=await ensure(tx,s),draft=(await tx.query('SELECT run_no FROM reading_listening67.web_draft WHERE '+clause,args(s))).rows[0];
  if(!draft||b.started_run_no>=draft.run_no)return;
  await tx.query('UPDATE reading_listening67.web_homework_binding SET started_run_no=$2 WHERE id=$1',[b.id,draft.run_no]);
  return append(tx,b,'started:'+draft.run_no,'status',await state(tx,s,b));
 }
 async function submitted(tx,s,attemptId){
  let b=await ensure(tx,s);const draft=(await tx.query('SELECT run_no FROM reading_listening67.web_draft WHERE '+clause,args(s))).rows[0];
  const a=(await tx.query('SELECT id FROM reading_listening67.web_attempt WHERE id=$5 AND '+clause,[...args(s),attemptId])).rows[0];if(!a)fail('DOC_IDENTITY_MISMATCH');
  await tx.query('UPDATE reading_listening67.web_homework_binding SET selected_attempt_id=$2,selected_run_no=$3 WHERE id=$1',[b.id,attemptId,draft.run_no]);
  b={...b,selected_attempt_id:attemptId,selected_run_no:draft.run_no};
  return append(tx,b,'submitted:'+draft.run_no+':'+attemptId,'status',await state(tx,s,b));
 }
 async function outcome(tx,s,jobId){const b=await ensure(tx,s);return append(tx,b,'outcome:'+jobId,'status',await state(tx,s,b));}
 async function register(s,target){
  if(target.classId!==s.courseId||target.studentRef!==s.ownerId||target.code!==s.code||target.version!==s.version)fail('DOC_IDENTITY_MISMATCH');
  const verified=await owner.verify(target);
  const ctaPlan=planWrite(await docs.read(verified.documentId),{document_id:verified.documentId,tab_id:verified.tabId,code:s.code},{kind:'cta',payload:{url:entryUrl}});
  await db.transaction(async tx=>{
   const b=await ensure(tx,s);
   if(b.target&&['classId','studentRef','code','version','courseId','courseWorkId','submissionId','documentId','tabId'].some(k=>b.target[k]!==verified[k]))fail('DOC_TARGET_CHANGED');
   await tx.query('UPDATE reading_listening67.web_homework_binding SET target=$2::jsonb WHERE id=$1',[b.id,JSON.stringify(verified)]);
   const cta=await append(tx,b,'cta','cta',{url:entryUrl,code:s.code,version:s.version});
   if(!ctaPlan.verified&&cta.status==='verified')await tx.query("UPDATE reading_listening67.web_homework_job SET status='pending',available_at=now(),attempts=0,verified_at=NULL,error_code=NULL WHERE id=$1 AND status='verified'",[cta.id]);
  });
  // Bài có từ chặng 3 hoặc học trước khi giao: nối trạng thái hiện có, không chấm/reset lại.
  await db.transaction(tx=>start(tx,s));
  return status(s);
 }
 async function status(s){
  const b=(await db.query('SELECT * FROM reading_listening67.web_homework_binding WHERE '+clause,args(s))).rows[0];
  if(!b)return {status:'not_started',cta:'pending',entryUrl};
  const jobs=(await db.query('SELECT id,sequence,kind,status,error_code AS "errorCode",verified_at AS "verifiedAt" FROM reading_listening67.web_homework_job WHERE binding_id=$1 ORDER BY sequence',[b.id])).rows;
  const last=jobs.filter(j=>j.kind==='status').at(-1),cta=jobs.find(j=>j.kind==='cta');
  return {status:last?.status||'not_started',cta:cta?.status||'pending',entryUrl,jobs,hasTarget:!!b.target};
 }
 async function once(){
  const job=await db.transaction(async tx=>{
   const j=(await tx.query("SELECT j.* FROM reading_listening67.web_homework_job j WHERE ((j.status='pending' AND j.available_at<=now()) OR (j.status='processing' AND j.lease_until<now())) AND NOT EXISTS(SELECT 1 FROM reading_listening67.web_homework_job old WHERE old.binding_id=j.binding_id AND old.sequence<j.sequence AND old.status<>'verified') ORDER BY j.created_at,j.sequence FOR UPDATE OF j SKIP LOCKED LIMIT 1")).rows[0];
   if(!j)return null;const leaseId=randomUUID();
   await tx.query("UPDATE reading_listening67.web_homework_job SET status='processing',lease_id=$2,lease_until=now()+interval '180 seconds',attempts=attempts+1 WHERE id=$1",[j.id,leaseId]);
   return {...j,leaseId,attempts:j.attempts+1};
  });
  if(!job)return false;
  try{
   const b=(await db.query('SELECT * FROM reading_listening67.web_homework_binding WHERE id=$1',[job.binding_id])).rows[0],s=scopeFor(b);
   const target=await owner.resolve(s,b.target);
   if(target.classId!==s.courseId||target.studentRef!==s.ownerId||target.code!==s.code||target.version!==s.version)fail('DOC_IDENTITY_MISMATCH');
   if(b.target&&['courseId','courseWorkId','submissionId','documentId','tabId'].some(k=>b.target[k]!==target[k]))fail('DOC_TARGET_CHANGED');
   await db.query('UPDATE reading_listening67.web_homework_binding SET target=$2::jsonb WHERE id=$1',[b.id,JSON.stringify(target)]);
   const effective={...b,document_id:target.documentId,tab_id:target.tabId,code:s.code};
   let plan=planWrite(await docs.read(target.documentId),effective,job);
   if(!plan.verified){await docs.write(target.documentId,plan);plan=planWrite(await docs.read(target.documentId),{...effective,last_doc_text:job.kind==='status'?job.payload.text:b.last_doc_text},job);}
   if(!plan.verified)fail('DOC_READBACK_FAILED');
   await db.transaction(async tx=>{
    const row=(await tx.query("UPDATE reading_listening67.web_homework_job SET status='verified',verified_at=now(),error_code=NULL,lease_until=NULL WHERE id=$1 AND lease_id=$2 AND status='processing' AND lease_until>now() RETURNING id",[job.id,job.leaseId])).rows[0];
    if(!row)fail('DOC_LEASE_LOST');
    if(job.kind==='status')await tx.query('UPDATE reading_listening67.web_homework_binding SET last_doc_sequence=$2,last_doc_text=$3,last_doc_link=$4 WHERE id=$1 AND last_doc_sequence<$2',[b.id,job.sequence,job.payload.text,job.payload.link]);
   });
  }catch(error){
   const code=error.code||'DOC_RETRY',missing=code==='HOMEWORK_NOT_FOUND';
   const hard=/^(?:DOC_(?:IDENTITY|TAB|CODE|STATUS|CTA|MANUAL|LINK|RANGE|TARGET)|OWNER_MISMATCH|DOCUMENT_OWNER_MISMATCH|HOMEWORK_LESSON_MISMATCH|DOC_HTTP_40[134]|HOMEWORK_HTTP_40[134])/.test(code);
   const blocked=hard||(!missing&&job.attempts>=8);
   await db.query("UPDATE reading_listening67.web_homework_job SET status=$3,error_code=$4,available_at=now()+$5*interval '1 second',lease_until=NULL WHERE id=$1 AND lease_id=$2 AND status='processing'",[job.id,job.leaseId,blocked?'blocked':'pending',code,missing?300:Math.min(300,2**job.attempts)]);
  }
  return true;
 }
 async function previewStatus(s){
  return db.transaction(async tx=>{
   const b=(await tx.query('SELECT * FROM reading_listening67.web_homework_binding WHERE '+clause,args(s))).rows[0];
   if(!b)return null;
   const payload=await state(tx,s,b);
   return {sequence:b.sequence,previousText:b.last_doc_text,previousLink:b.last_doc_link,target:b.target,payload};
  });
 }
 async function refreshStatus(s,expected){
  return db.transaction(async tx=>{
   const b=(await tx.query('SELECT * FROM reading_listening67.web_homework_binding WHERE '+clause+' FOR UPDATE',args(s))).rows[0];
   if(!b)return null;
   const payload=await state(tx,s,b);
   if(!expected||b.sequence!==expected.sequence||b.last_doc_text!==expected.previousText||b.last_doc_link!==expected.previousLink||JSON.stringify(payload)!==JSON.stringify(expected.payload))fail('DOC_REFRESH_CHANGED');
   const old=(await tx.query("SELECT payload,status FROM reading_listening67.web_homework_job WHERE binding_id=$1 AND kind='status' ORDER BY sequence DESC LIMIT 1",[b.id])).rows[0];
   if(!old||old.payload.text===payload.text&&old.payload.link===payload.link)return null;
   if(old.status!=='verified'||b.last_doc_sequence!==b.sequence)fail('DOC_REFRESH_PENDING');
   return append(tx,b,'progress-v1:'+b.sequence+':'+(payload.attemptId||payload.runNo),'status',payload);
  });
 }
 return {entryUrl,teacherUrl,start,submitted,outcome,register,status,once,previewStatus,refreshStatus};
}
