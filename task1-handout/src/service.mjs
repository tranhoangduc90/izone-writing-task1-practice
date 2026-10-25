import {createWritingPracticeService,ApiError} from '../vendor/service.js';
import {createProvisionalStudentService} from '../vendor/provisional-service.js';
import {createTeacherCommentService} from '../vendor/teacher-comment-service.js';
import {validateFeedback,sha} from './grading.mjs';
export {ApiError};
export function createService({pool,pepper,history=null}){
 const provisional=createProvisionalStudentService({pool,pepper});
 const core=createWritingPracticeService({pool,provisionalService:provisional});
 const comments=createTeacherCommentService({pool});
 async function withSnapshots(details,ref){
  const rows=await pool.query('SELECT a.public_id,a.snapshot FROM writing_practice.check_attempt a JOIN writing_practice.activity_session s ON s.id=a.session_id WHERE s.public_id=$1',[ref]);
  const snapshots=new Map(rows.rows.map(a=>[a.public_id,a.snapshot]));
  return {...details,comments:details.comments.map(c=>({...c,snapshot:snapshots.get(c.attemptRef)||null}))};
 }
 return {...core,provisional,history,comments:{...comments,async list(input){const h=history?await history():null;return h?.comments(input.sessionRef)||comments.list(input);}},
  async saveDraft(input){return withSnapshots(await core.saveDraft(input),input.sessionRef);},
  async openSession(input){
   const scope=await pool.query("SELECT 1 FROM writing_practice.activity_class_scope c JOIN writing_practice.activity a ON a.id=c.activity_id WHERE a.slug=$1 AND c.public_id=$2 AND a.status='active' AND c.status='active' AND c.end_date>=CURRENT_DATE",[input.activitySlug,input.classRef]);
   if(!scope.rowCount)throw new ApiError(404,'SESSION_NOT_ALLOWED','Lớp hoặc bài không còn mở.');return core.openSession(input);
  },
  async sessionDetails(ref){
   const h=history?await history():null,old=h?.details(ref);if(old)return old;
   const details=await core.sessionDetails(ref);
   // Chỉ đọc bản gửi đã đóng băng theo đúng phiên; không dùng bài nháp hiện tại thay thế.
   return withSnapshots(details,ref);
  },
  async getAttempt(ref){
   const h=history?await history():null,old=h?.attempt(ref);if(old)return old;
   const attempt=await core.getAttempt(ref);
   const rows=await pool.query('SELECT snapshot FROM writing_practice.check_attempt WHERE public_id=$1',[ref]);
   const snapshot=rows.rows[0]?.snapshot||null;
   return {...attempt,snapshot,comment:attempt.comment?{...attempt.comment,snapshot}:attempt.comment};
  },
  async claimJobs(input){
   if(input.workerPool&&input.workerPool!=='task1')throw new ApiError(400,'WRONG_PRODUCT','Sai hàng chấm.');
   if(input.maxJobs>2)throw new ApiError(400,'CAPACITY_EXCEEDED','Tối đa hai lượt đồng thời.');
   const jobs=await core.claimJobs({...input,workerPool:'task1'});
   for(const job of jobs){const r=await pool.query('SELECT c.context FROM task1_private.attempt_context c JOIN writing_practice.check_attempt a ON a.id=c.attempt_id WHERE a.public_id=$1',[job.jobRef]);job.gradingContext=r.rows[0]?.context;if(!job.gradingContext)throw Error('FROZEN_CONTEXT_REQUIRED');}
   return jobs;
  },
  async completeJob(input){
   if(input.artifacts?.productId!=='sw-task1'||input.artifacts?.attemptRef!==input.jobRef||input.artifacts?.mode!=='socratic-v2'||input.artifacts?.lmsUrl)throw new ApiError(400,'WRONG_RESULT_CONTRACT','Cần kết quả Socratic đúng sản phẩm.');
   const r=await pool.query('SELECT c.context FROM task1_private.attempt_context c JOIN writing_practice.check_attempt a ON a.id=c.attempt_id WHERE a.public_id=$1',[input.jobRef]);
   const ctx=r.rows[0]?.context;
   if(!ctx||input.artifacts.promptSha256!==ctx.promptSha256||input.artifacts.snapshotSha256!==sha(ctx.snapshot)||input.resultStatus!==validateFeedback(input.feedback,ctx.section))throw new ApiError(400,'RESULT_CONTEXT_MISMATCH','Kết quả không khớp bản gửi chấm.');
   return core.completeJob(input);
  }
 };
}
