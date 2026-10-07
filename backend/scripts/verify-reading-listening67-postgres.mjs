/**
 * Kiểm API và giao dịch PostgreSQL thật trong database thử riêng.
 * Dữ liệu đều do ca thử tạo, không đọc bài/học viên. Assertion sai trả exit khác 0.
 */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {createReadingListening67Store} from '../src/reading-listening67/store.js';
const connectionString=process.env.READING_LISTENING67_DATABASE_URL;
if(!connectionString||new URL(connectionString).pathname!=='/reading_listening67_test')throw Error('RL67_TEST_DATABASE_REQUIRED');
const pool=new pg.Pool({connectionString,max:2});
const store=createReadingListening67Store({pool});
const id=()=>randomUUID();
const document=()=>`test_rl67_${id().replaceAll('-','')}`;
let assertions=0;
function check(value,message){assert.ok(value,message);assertions++;}
async function rejects(work,code){await assert.rejects(work,e=>e.code===code);assertions++;}
const base='http://127.0.0.1:8791/api/v1/internal/reading-listening67';
async function api(path,body,token=process.env.READING_LISTENING67_INTERNAL_TOKEN){
 const r=await fetch(base+path,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});return {status:r.status,data:await r.json()};
}
try{
 // Đóng chỉ dữ liệu giả của các lượt test trước, không chạm Docs thật.
 await pool.query("UPDATE reading_listening67.job SET status='failed',error_code='TEST_FIXTURE_CLOSED',lease_expires_at=NULL WHERE document_id LIKE 'test_rl67_%' AND status IN ('queued','validating','grading','writing','needs_review')");
 check((await pool.query("SELECT count(*)::int AS n FROM reading_listening67.job WHERE status IN ('validating','grading','writing')")).rows[0].n===0,'Không có lượt thật đang chạy trước ca năng lực');
 const unauth=await api('/ready',null,'wrong');check(unauth.status===401,'Token riêng bắt buộc');
 check((await api('/ready')).data.ok,'Role và bảng thật sẵn sàng');
 const input={documentId:document(),assignmentCode:'67-reading-01',requestId:id()};
 const accepted=await Promise.all(Array.from({length:12},()=>store.accept(input)));
 check(new Set(accepted.map(x=>x.jobId)).size===1,'12 request cùng identity chỉ một job');
 const j=accepted[0].jobId;
 check((await pool.query('SELECT count(*)::int AS n FROM reading_listening67.job WHERE document_id=$1',[input.documentId])).rows[0].n===1,'Database đúng một job');
 await rejects(()=>store.accept({...input,documentId:document()}),'REQUEST_IDENTITY_MISMATCH');
 await rejects(()=>store.accept({...input,assignmentCode:'67-listening-01',requestId:id()}),'DOCUMENT_BUSY');
 const owners=await Promise.allSettled(Array.from({length:8},()=>store.claim({jobId:j,executionId:id()})));
 check(owners.filter(x=>x.status==='fulfilled').length===1,'Chỉ một execution lấy lease');
 const owner=owners.find(x=>x.status==='fulfilled').value;
 await rejects(()=>store.renew({jobId:j,leaseToken:id()}),'LEASE_NOT_OWNED');
 await rejects(()=>store.validate({...input,jobId:j,leaseToken:owner.leaseToken,documentId:document(),sourceRevision:'revision1',templateVersion:'fixture',graderVersion:'fixture',answerSha256:'a'.repeat(64),done:79,total:100}),'VALIDATION_IDENTITY_MISMATCH');
 const validated=await store.validate({...input,jobId:j,leaseToken:owner.leaseToken,sourceRevision:'revision1',templateVersion:'fixture',graderVersion:'fixture',answerSha256:'a'.repeat(64),done:79,total:100});
 check(!validated.enough&&validated.status==='writing','79% không chấm');
 await rejects(()=>store.finish({jobId:j,leaseToken:owner.leaseToken,status:'done',warningState:'absent_verified'}),'DONE_PROOF_INVALID');
 await rejects(()=>store.finish({jobId:j,leaseToken:owner.leaseToken,status:'incomplete',warningState:'present_verified'}),'READBACK_PROOF_REQUIRED');
 const finished={jobId:j,leaseToken:owner.leaseToken,status:'incomplete',warningState:'present_verified',result:{completion:79},proof:{documentId:input.documentId,assignmentCode:input.assignmentCode,jobId:j,verified:true,revisionId:'revision2'}};
 check((await store.finish(finished)).status==='incomplete','Lưu dưới ngưỡng sau proof');
 check((await store.finish(finished)).replayed,'Callback lặp an toàn');
 await rejects(()=>store.finish({...finished,result:{completion:80}}),'RESULT_REPLAY_MISMATCH');
 const next=await store.accept({...input,requestId:id()});check(next.jobId!==j,'Bấm lại sau bổ sung tạo lượt mới');
 const nextOwner=await store.claim({jobId:next.jobId,executionId:id()});
 await rejects(()=>store.renew({...nextOwner,phase:'writing'}),'WRITING_VALIDATION_REQUIRED');
 check((await store.validate({...input,jobId:next.jobId,leaseToken:nextOwner.leaseToken,sourceRevision:'revision3',templateVersion:'fixture',graderVersion:'fixture',answerSha256:'b'.repeat(64),done:80,total:100})).enough,'Đúng 80% được chấm');
 await store.renew({...nextOwner,phase:'writing'});
 check((await store.status({jobId:next.jobId})).status==='writing','Bắt đầu ghi phải lưu phase trước side effect');
 await rejects(()=>store.finish({jobId:next.jobId,leaseToken:nextOwner.leaseToken,status:'done',warningState:'present_verified'}),'DONE_PROOF_INVALID');
 check((await store.finish({jobId:next.jobId,leaseToken:nextOwner.leaseToken,status:'done',warningState:'absent_verified',result:{score:1},proof:{documentId:input.documentId,assignmentCode:input.assignmentCode,jobId:next.jobId,verified:true,revisionId:'revision4'}})).status==='done','Done yêu cầu cảnh báo đã xóa');
 const context={documentId:document(),assignmentCode:'67-listening-01'};
 const classroom={courseId:'fixture_course_'+id(),courseworkId:'fixture_work',submissionId:'fixture_submission',studentId:'fixture_student',classCode:'fixture_class',sourceEventId:id()};
 await store.register({...context,classroom});await store.register({...context,classroom});
 check((await pool.query('SELECT count(*)::int AS n FROM reading_listening67.classroom_binding WHERE course_id=$1',[classroom.courseId])).rows[0].n===1,'Binding chống trùng');
 const external=await store.register({documentId:document(),assignmentCode:'67-reading-02'});check(external.sourceKind==='outside_classroom','File ngoài Classroom được lưu');
 // Hai kết nối tranh request id cùng lúc nhưng khác Docs phải trả lỗi identity có thể hiểu.
 const blocker=await pool.connect();await blocker.query('BEGIN');await blocker.query('LOCK TABLE reading_listening67.job IN SHARE MODE');
 const raceId=id();const pending=Promise.all([api('/accept',{documentId:document(),assignmentCode:'67-reading-03',requestId:raceId}),api('/accept',{documentId:document(),assignmentCode:'67-reading-03',requestId:raceId})]);
 try {
  let waiting=0;
  for(let attempt=0;attempt<100;attempt++) {
   waiting=(await pool.query(`SELECT count(DISTINCT pid)::int AS n FROM pg_locks WHERE NOT granted
    AND pid IN (SELECT pid FROM pg_stat_activity WHERE usename=current_user)`)).rows[0].n;
   if(waiting>=2)break;
   await new Promise(resolve=>setTimeout(resolve,20));
  }
  check(waiting>=2,'Ca race đã thực sự giữ hai kết nối chờ, không dựa vào may rủi');
 } finally {await blocker.query('COMMIT');blocker.release();}
 const race=await pending;
 check(race.filter(x=>x.status===202).length===1,'Request id xung đột chỉ tạo một job');
 check(race.some(x=>x.status===409&&x.data.error==='REQUEST_IDENTITY_MISMATCH'),'Request id xung đột phải trả 409 có mã identity');
 const capacityJobs=await Promise.all(Array.from({length:3},()=>store.accept({documentId:document(),assignmentCode:'67-reading-04',requestId:id()})));
 const claims=await Promise.all(capacityJobs.map(x=>store.claim({jobId:x.jobId,executionId:id()})));
 check(claims.filter(x=>x.leaseToken).length===2,'Hai lượt tối đa qua giao dịch tranh nhau');
 const deferred=claims.find(x=>x.deferred);
 check(!!deferred&&deferred.status==='queued','Lượt thứ ba giữ queued, không mất yêu cầu');
 check(await store.dispatchDue()===null,'Nhịp gọi n8n dừng khi đủ hai lượt');
 const first=claims.find(x=>x.leaseToken);
 await store.finish({jobId:first.jobId,leaseToken:first.leaseToken,status:'failed',errorCode:'TEST_CAPACITY_RELEASE'});
 const resumed=await store.claim({jobId:deferred.jobId,executionId:id()});check(!!resumed.leaseToken,'Lượt đợi lấy được lease khi năng lực trống');
 for(const x of [...claims.filter(x=>x.leaseToken&&x.jobId!==first.jobId),resumed])await store.finish({jobId:x.jobId,leaseToken:x.leaseToken,status:'failed',errorCode:'TEST_CAPACITY_RELEASE'});
 const reviewInput={documentId:document(),assignmentCode:'67-reading-05',requestId:id()};
 const reviewJob=await store.accept(reviewInput);const executionId=id();const reviewOwner=await store.claim({jobId:reviewJob.jobId,executionId});
 await store.finish({jobId:reviewJob.jobId,leaseToken:reviewOwner.leaseToken,status:'needs_review',errorCode:'RL67_CHECK_EXECUTION_AND_DOCS'});
 const proof={documentId:reviewInput.documentId,assignmentCode:reviewInput.assignmentCode,verified:true,processorStopped:true,warningStopped:true,noWarningWriteAttempted:true,noGradingInvoked:true,sourceError:'RL67_WARNING_SOURCE_CHANGED',revisionId:'test_revision',warningExecutionId:id()};
 await rejects(()=>store.resolveReview({jobId:reviewJob.jobId,processorExecutionId:executionId,proof:{...proof,documentId:document()}}),'REVIEW_IDENTITY_MISMATCH');
 await rejects(()=>store.resolveReview({jobId:reviewJob.jobId,processorExecutionId:executionId,proof:{...proof,noGradingInvoked:false}}),'REVIEW_PROOF_INVALID');
 check((await store.resolveReview({jobId:reviewJob.jobId,processorExecutionId:executionId,proof})).reviewed,'Chỉ mở lại sau chứng minh chưa ghi/chấm');
 check((await store.resolveReview({jobId:reviewJob.jobId,processorExecutionId:executionId,proof})).replayed,'Biên nhận đối chiếu lặp an toàn');
 check((await store.accept({...reviewInput,requestId:id()})).jobId!==reviewJob.jobId,'Sau đối chiếu được bấm lượt mới');
 const sources=[1,2,3].map(i=>({documentId:document(),classroom:{courseId:'fixture_batch_course_'+id(),courseworkId:'work'+i,submissionId:'sub'+i,studentId:'student'+i,classCode:'Cùng tên',sourceEventId:id()}}));
 check((await api('/sourceBatch',{sources})).data.sources.length===3,'API lưu một nhóm ba nguồn có lớp xen kẽ');
 check((await api('/sourceBatch',{sources:sources.toReversed()})).data.sources.length===3,'Retry đảo nguồn vẫn đủ ACK identity');
 const acked=(await api('/sourceBatch',{sources})).data.sources;
 const markers=acked.map(({documentId,courseId,courseworkId,submissionId,dispatchToken})=>({documentId,courseId,courseworkId,submissionId,dispatchToken}));
 check((await api('/sourceCtaEnqueuedBatch',{sources:markers.toReversed()})).data.sources.every(x=>x.marked),'Chỉ xác nhận sau Rabbit đã gửi, đúng identity đảo thứ tự');
 check((await api('/sourceBatch',{sources})).data.sources.every(x=>!x.ctaNeeded),'Lượt đồng bộ kế tiếp không gửi lại CTA còn trong queue');
 await rejects(()=>store.sourceCtaEnqueuedBatch({sources:[{...markers[0],submissionId:'foreign_submission'}]}),'SOURCE_DISPATCH_IDENTITY_MISMATCH');
 await store.sourceCtaResult({documentId:sources[0].documentId,state:'error'});
 check(!(await store.sourceCtaEnqueuedBatch({sources:[markers[0]]})).sources[0].marked,'ACK muộn không ghi đè callback lỗi');
 check((await store.source(sources[0])).ctaNeeded,'File lỗi được thử lại sau lượt rà kế tiếp');
 await store.sourceCtaResult({documentId:sources[1].documentId,state:'ready'});
 check(!(await store.sourceCtaState({documentId:sources[1].documentId})).shouldProcess,'Event lặp đã hoàn tất không đọc Google lần nữa');
 for(const s of sources){const r=(await pool.query('SELECT course_id,student_id FROM reading_listening67.source_document WHERE document_id=$1',[s.documentId])).rows;check(r.length===1&&r[0].course_id===s.classroom.courseId&&r[0].student_id===s.classroom.studentId,'Đọc lại đúng lớp/học viên, không nhân đôi nguồn');}
 const sourceUnit=await store.register({documentId:sources[0].documentId,assignmentCode:'67-reading-01'});check(sourceUnit.sourceKind==='classroom','Bấm/nhận diện sau nguồn tự nối đúng Classroom');
 const scanClaims=await Promise.all(Array.from({length:4},()=>store.scanStart({executionId:id()})));check(scanClaims.filter(x=>x.acquired).length===1,'Bốn master cùng lúc chỉ một lượt đọc nguồn');
 const scan=scanClaims.find(x=>x.acquired);await store.scanCourseResult({...scan,courseId:'fixture_course1',status:'done'});await store.scanCourseResult({...scan,courseId:'fixture_course2',status:'failed',errorCode:'TEST_SOURCE_PARTIAL'});
 check((await store.scanFinish(scan)).status==='partial','Database không biến nguồn thiếu một lớp thành success');
 console.log(JSON.stringify({ok:true,assertions,realPostgres:true,poolMax:2}));
}finally{await pool.end();}
