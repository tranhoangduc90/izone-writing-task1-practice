import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { ApiError } from './service.js';

const uuid=z.string().uuid(), section=z.enum(['overview','outline','draft']);
const lessonSection=z.string().regex(/^[a-z0-9][a-z0-9_]{1,79}$/);
const responseMap=z.record(z.string().regex(/^[a-z0-9][a-z0-9_]{1,79}$/),z.string().max(20_000)).superRefine((value,context)=>{
 if(Object.keys(value).length>40)context.addIssue({code:'custom',message:'Quá nhiều ô bài làm.'});
});
const meaningfulText = (value) => value.replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu, '');
const draft=z.object({overview:z.string().max(20_000),body1:z.string().max(20_000),body2:z.string().max(20_000),draft1:z.string().max(20_000).optional(),draft2:z.string().max(20_000).optional(),draft2Unlocked:z.boolean().optional()});
const activitySlug=z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/);
const open=z.object({activitySlug,classRef:uuid,studentRef:uuid,accessCode:z.string().regex(/^\d{4}$/).optional()});
const provisionalCreate=z.object({classRef:uuid,displayName:z.string().min(2).max(100),pin:z.string().regex(/^\d{4}$/),requestId:uuid,duplicateConfirmed:z.boolean().default(false)});
const reconcile=z.object({officialStudentRef:uuid});
const save=z.object({baseVersion:z.number().int().min(0),requestId:uuid,...draft.shape});
const check=z.object({section,requestId:uuid,snapshot:draft}).superRefine((value,context)=>{
 if(value.section==='overview'&&!meaningfulText(value.snapshot.overview))context.addIssue({code:'custom',path:['snapshot','overview'],message:'Overview trống.'});
 if(value.section==='outline'&&!meaningfulText(value.snapshot.body1)&&!meaningfulText(value.snapshot.body2))context.addIssue({code:'custom',path:['snapshot'],message:'Outline trống.'});
 if(value.section==='draft'&&(!meaningfulText(value.snapshot.draft1||'')||!meaningfulText(value.snapshot.draft2||'')))context.addIssue({code:'custom',path:['snapshot'],message:'Draft 1 và Draft 2 không được để trống.'});
});
// maxJobs chỉ giới hạn kích thước một response để bảo vệ API; số job đang chấm đồng thời do n8n kiểm soát.
const claim=z.object({workerId:z.string().trim().min(1).max(100),maxJobs:z.number().int().min(1).max(100).default(1),leaseSeconds:z.literal(420),workerPool:z.string().regex(/^[a-z0-9][a-z0-9_-]{1,49}$/).default('task1')});
const gradingResult=z.enum(['passed','needs_revision']);
const complete=z.object({leaseToken:uuid,resultStatus:gradingResult.optional(),status:gradingResult.optional(),feedback:z.string().trim().min(1).max(20_000),artifacts:z.record(z.string(),z.unknown()).optional()})
 .superRefine((value,context)=>{if(!value.resultStatus&&!value.status)context.addIssue({code:'custom',path:['status'],message:'Thiếu kết quả chấm.'});})
 .transform(value=>({...value,resultStatus:value.resultStatus||value.status}));
const fail=z.object({leaseToken:uuid,errorCode:z.string().trim().min(1).max(100),retryable:z.boolean()});
const reopen=z.object({reason:z.string().trim().min(3).max(500)});
const lessonSave=z.object({baseVersion:z.number().int().min(0),requestId:uuid,responses:responseMap});
const lessonCheck=z.object({section:lessonSection,requestId:uuid});
const liveUpdate=z.object({activeField:lessonSection.nullable().optional()});
const teacherCommentBody=z.string().trim().min(1).max(5000);
const teacherCommentCreate=z.object({sectionKey:lessonSection,fieldKey:lessonSection,start:z.number().int().min(0),end:z.number().int().positive(),baseVersion:z.number().int().min(0),body:teacherCommentBody,requestId:uuid})
 .superRefine((value,context)=>{if(value.end<=value.start||value.end-value.start>2000)context.addIssue({code:'custom',path:['end'],message:'Đoạn comment không hợp lệ.'});});
const teacherCommentReply=z.object({body:teacherCommentBody,requestId:uuid});
const teacherCommentStatus=z.object({status:z.enum(['open','addressed']),requestId:uuid});
const parse=(schema,value,code='INVALID_REQUEST')=>{const r=schema.safeParse(value);if(!r.success)throw new ApiError(400,code,'Dữ liệu gửi lên không hợp lệ.');return r.data;};
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
function sameSecret(actual,expected){const a=Buffer.from(String(actual||'')),b=Buffer.from(String(expected||''));return a.length>0&&a.length===b.length&&crypto.timingSafeEqual(a,b);}
function cors(config){return(req,res,next)=>{const origin=req.get('origin');if(origin&&!config.allowedOrigins.has(origin))return res.status(403).json({ok:false,error:'ORIGIN_NOT_ALLOWED'});if(origin){res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');}res.set('Access-Control-Allow-Methods','GET, POST, PUT, OPTIONS');res.set('Access-Control-Allow-Headers','Authorization, Content-Type, If-None-Match, If-Match');res.set('Cache-Control','no-store');return req.method==='OPTIONS'?res.status(204).end():next();};}
function csvCell(value){const text=String(value??'');return /[",\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;}

export function createApp({config,pool,service,lessonService=service,provisionalService=null,lmsResultService=null,teacherCommentService=null,adminAuth=(_q,r)=>r.status(503).json({ok:false,error:'ADMIN_AUTH_NOT_CONFIGURED'})}){
 const app=express();app.disable('x-powered-by');app.set('trust proxy',config.trustProxyHops);app.use(helmet());app.use(cors(config));
 const teacherManage=(q,r,next)=>q.reviewer?.canManage===true?next():r.status(403).json({ok:false,error:'MANAGE_PERMISSION_REQUIRED'});
 // Một lớp có thể dùng chung một địa chỉ mạng. Ngưỡng đọc này vẫn chịu được 40 học viên polling 2 giây/lần.
 app.use(rateLimit({windowMs:60_000,limit:2400,standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,error:'RATE_LIMITED'}}));app.use(express.json({limit:'96kb',strict:true}));
 app.get('/health',(_q,r)=>r.json({ok:true}));app.get('/ready',asyncRoute(async(_q,r)=>{await pool.query('SELECT 1');r.json({ok:true});}));const writes=rateLimit({windowMs:60_000,limit:240,standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,error:'RATE_LIMITED'}});
 const provisionalWrites=rateLimit({windowMs:10*60_000,limit:60,standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,error:'PROVISIONAL_REGISTRATION_RATE_LIMITED'}});
 app.get('/api/v1/activities/:slug/roster',asyncRoute(async(q,r)=>r.json({ok:true,...await service.getRoster(q.params.slug)})));
 app.post('/api/v1/activities/:slug/provisional-students',provisionalWrites,asyncRoute(async(q,r)=>{
   if(!provisionalService)throw new ApiError(503,'PROVISIONAL_STUDENTS_NOT_CONFIGURED','Chức năng học viên tạm chưa được cấu hình.');
   r.status(201).json({ok:true,student:await provisionalService.createStudent({activitySlug:parse(activitySlug,q.params.slug),...parse(provisionalCreate,q.body)})});
 }));
 app.post('/api/v1/sessions',writes,asyncRoute(async(q,r)=>r.status(201).json({ok:true,session:await service.openSession(parse(open,q.body))})));
 app.get('/api/v1/sessions/:sessionRef',asyncRoute(async(q,r)=>r.json({ok:true,session:await service.sessionDetails(parse(uuid,q.params.sessionRef))})));
 app.get('/api/v1/sessions/:sessionRef/draft-result',asyncRoute(async(q,r)=>{
   if(!lmsResultService)throw new ApiError(503,'LMS_RESULT_NOT_CONFIGURED','Kết quả LMS chưa được cấu hình.');
   r.json({ok:true,result:await lmsResultService.getDraftResult({sessionRef:parse(uuid,q.params.sessionRef)})});
 }));
 app.put('/api/v1/sessions/:sessionRef/draft',writes,asyncRoute(async(q,r)=>r.json({ok:true,session:await service.saveDraft({sessionRef:parse(uuid,q.params.sessionRef),...parse(save,q.body)})})));
 app.post('/api/v1/sessions/:sessionRef/checks',writes,asyncRoute(async(q,r)=>r.status(202).json({ok:true,attempt:await service.submitCheck({sessionRef:parse(uuid,q.params.sessionRef),...parse(check,q.body)})})));
 app.put('/api/v1/sessions/:sessionRef/live',writes,asyncRoute(async(q,r)=>r.json({ok:true,...await service.publishLive({sessionRef:parse(uuid,q.params.sessionRef)})})));
 app.post('/api/v1/lesson-sessions',writes,asyncRoute(async(q,r)=>r.status(201).json({ok:true,session:await lessonService.openSession(parse(open,q.body))})));
 app.get('/api/v1/lesson-sessions/:sessionRef',asyncRoute(async(q,r)=>r.json({ok:true,session:await lessonService.sessionDetails(parse(uuid,q.params.sessionRef))})));
 app.put('/api/v1/lesson-sessions/:sessionRef/responses',writes,asyncRoute(async(q,r)=>r.json({ok:true,session:await lessonService.saveResponses({sessionRef:parse(uuid,q.params.sessionRef),...parse(lessonSave,q.body)})})));
 app.post('/api/v1/lesson-sessions/:sessionRef/checks',writes,asyncRoute(async(q,r)=>r.status(202).json({ok:true,attempt:await lessonService.submitCheck({sessionRef:parse(uuid,q.params.sessionRef),...parse(lessonCheck,q.body)})})));
 app.put('/api/v1/lesson-sessions/:sessionRef/live',writes,asyncRoute(async(q,r)=>r.json({ok:true,...await lessonService.publishLive({sessionRef:parse(uuid,q.params.sessionRef),...parse(liveUpdate,q.body)})})));
 const commentsReady=()=>{if(!teacherCommentService)throw new ApiError(503,'TEACHER_COMMENTS_NOT_CONFIGURED','Comment giảng viên chưa được cấu hình.');return teacherCommentService;};
 app.get('/api/v1/sessions/:sessionRef/teacher-comments',asyncRoute(async(q,r)=>{const data=await commentsReady().list({sessionRef:parse(uuid,q.params.sessionRef)});const tag=`"teacher-comments-${data.version}"`;if(q.get('if-none-match')===tag)return r.status(304).end();r.set('ETag',tag);return r.json({ok:true,threads:data.threads});}));
 app.post('/api/v1/sessions/:sessionRef/teacher-comments/:threadRef/replies',writes,asyncRoute(async(q,r)=>r.status(201).json({ok:true,thread:await commentsReady().reply({threadRef:parse(uuid,q.params.threadRef),sessionRef:parse(uuid,q.params.sessionRef),actorRole:'student',actorRef:'student',...parse(teacherCommentReply,q.body)})})));
 app.get('/api/v1/attempts/:attemptRef',asyncRoute(async(q,r)=>{const attempt=await service.getAttempt(parse(uuid,q.params.attemptRef));const tag=`"attempt-${attempt.version}"`;if(q.get('if-none-match')===tag)return r.status(304).end();r.set('ETag',tag);return r.json({ok:true,attempt});}));
 app.post('/api/v1/attempts/:attemptRef/retry',writes,asyncRoute(async(q,r)=>r.status(202).json({ok:true,attempt:await service.retryAttempt(parse(uuid,q.params.attemptRef))})));
 const internal=(q,r,next)=>sameSecret((q.get('authorization')||'').replace(/^Bearer\s+/i,''),config.internalApiToken)?next():r.status(401).json({ok:false,error:'UNAUTHORIZED'});
 app.post('/api/v1/internal/grading-jobs/claim',internal,asyncRoute(async(q,r)=>r.json({ok:true,jobs:await service.claimJobs(parse(claim,q.body))})));
 app.post('/api/v1/internal/grading-jobs/:jobRef/complete',internal,asyncRoute(async(q,r)=>r.json({ok:true,job:await service.completeJob({jobRef:parse(uuid,q.params.jobRef),...parse(complete,q.body)})})));
 app.post('/api/v1/internal/grading-jobs/:jobRef/fail',internal,asyncRoute(async(q,r)=>r.json({ok:true,job:await service.failJob({jobRef:parse(uuid,q.params.jobRef),...parse(fail,q.body)})})));
 app.post('/api/v1/internal/grading-jobs/recover',internal,asyncRoute(async(_q,r)=>r.json({ok:true,jobs:await service.recoverJobs()})));
 app.post('/api/v1/admin/sessions/:sessionRef/sections/:section/reopen',adminAuth,teacherManage,asyncRoute(async(q,r)=>r.json({ok:true,session:await service.reopenSection({sessionRef:parse(uuid,q.params.sessionRef),section:parse(section,q.params.section),actorRef:q.reviewer.email,...parse(reopen,q.body)})})));
 app.get('/api/v1/admin/live/activities/:slug',adminAuth,asyncRoute(async(q,r)=>{const data=await lessonService.listLive({activitySlug:parse(activitySlug,q.params.slug),classRef:q.query.classRef?parse(uuid,q.query.classRef):null});r.json({ok:true,...data,permissions:{canManage:Boolean(q.reviewer?.canManage)}});}));
 app.get('/api/v1/admin/activities/:slug/provisional-students',adminAuth,asyncRoute(async(q,r)=>r.json({ok:true,students:await provisionalService.listPending({activitySlug:parse(activitySlug,q.params.slug),classRef:q.query.classRef?parse(uuid,q.query.classRef):null})})));
 app.post('/api/v1/admin/provisional-students/:studentRef/reset-code',adminAuth,teacherManage,asyncRoute(async(q,r)=>r.json({ok:true,...await provisionalService.resetCode({studentRef:parse(uuid,q.params.studentRef),actorRef:q.reviewer.email})})));
 app.post('/api/v1/admin/provisional-students/:studentRef/reconcile',adminAuth,teacherManage,asyncRoute(async(q,r)=>r.json({ok:true,...await provisionalService.reconcile({studentRef:parse(uuid,q.params.studentRef),actorRef:q.reviewer.email,...parse(reconcile,q.body)})})));
 app.get('/api/v1/admin/activities/:slug/export.csv',adminAuth,asyncRoute(async(q,r)=>{const data=await lessonService.listLive({activitySlug:parse(activitySlug,q.params.slug),classRef:q.query.classRef?parse(uuid,q.query.classRef):null});const header=['Họ và tên','Lớp','Tiến trình (%)','Số ô đã làm','Số phần đã đạt','Số lần Check','Cần hỗ trợ','Học viên tạm','Trạng thái đối soát'];const lines=[header,...data.students.map(s=>[s.displayName,s.className,s.progressPercent,s.filledFields,s.passedSectionCount,s.checkCount,s.supportRequired?'Có':'Không',s.provisional?'Có':'Không',s.reconciliationStatus||'official'])].map(row=>row.map(csvCell).join(','));r.type('text/csv; charset=utf-8').set('Content-Disposition',`attachment; filename="${q.params.slug}-progress.csv"`).send(`\ufeff${lines.join('\r\n')}`);}));
 app.get('/api/v1/admin/live/sessions/:sessionRef',adminAuth,asyncRoute(async(q,r)=>{const ref=parse(uuid,q.params.sessionRef);try{return r.json({ok:true,session:await lessonService.sessionDetails(ref)});}catch(error){if(error.code!=='SESSION_NOT_FOUND')throw error;return r.json({ok:true,session:await service.sessionDetails(ref)});}}));
 app.get('/api/v1/admin/live/lesson-sessions/:sessionRef',adminAuth,asyncRoute(async(q,r)=>r.json({ok:true,session:await lessonService.sessionDetails(parse(uuid,q.params.sessionRef))})));
 app.get('/api/v1/admin/live/sessions/:sessionRef/teacher-comments',adminAuth,asyncRoute(async(q,r)=>{const data=await commentsReady().list({sessionRef:parse(uuid,q.params.sessionRef)});const tag=`"teacher-comments-${data.version}"`;if(q.get('if-none-match')===tag)return r.status(304).end();r.set('ETag',tag);return r.json({ok:true,threads:data.threads});}));
 app.post('/api/v1/admin/live/sessions/:sessionRef/teacher-comments',writes,adminAuth,asyncRoute(async(q,r)=>r.status(201).json({ok:true,thread:await commentsReady().create({sessionRef:parse(uuid,q.params.sessionRef),actorRef:q.reviewer.email,...parse(teacherCommentCreate,q.body)})})));
 app.post('/api/v1/admin/teacher-comments/:threadRef/replies',writes,adminAuth,asyncRoute(async(q,r)=>r.status(201).json({ok:true,thread:await commentsReady().reply({threadRef:parse(uuid,q.params.threadRef),actorRole:'teacher',actorRef:q.reviewer.email,...parse(teacherCommentReply,q.body)})})));
 app.post('/api/v1/admin/teacher-comments/:threadRef/status',writes,adminAuth,asyncRoute(async(q,r)=>r.json({ok:true,thread:await commentsReady().setStatus({threadRef:parse(uuid,q.params.threadRef),actorRef:q.reviewer.email,...parse(teacherCommentStatus,q.body)})})));
 app.post('/api/v1/admin/attempts/:attemptRef/retry',writes,adminAuth,teacherManage,asyncRoute(async(q,r)=>r.status(202).json({ok:true,attempt:await lessonService.retryFailedAttempt({attemptRef:parse(uuid,q.params.attemptRef),actorRef:q.reviewer.email})})));
 app.post('/api/v1/admin/lesson-sessions/:sessionRef/sections/:section/reopen',adminAuth,teacherManage,asyncRoute(async(q,r)=>r.json({ok:true,session:await lessonService.reopenSection({sessionRef:parse(uuid,q.params.sessionRef),section:parse(lessonSection,q.params.section),actorRef:q.reviewer.email,...parse(reopen,q.body)})})));
 app.use((_q,r)=>r.status(404).json({ok:false,error:'NOT_FOUND'}));app.use((error,_q,r,_n)=>{if(error instanceof ApiError)return r.status(error.status).json({ok:false,error:error.code,message:error.message,...(error.current?{current:error.current}:{})});const requestId=crypto.randomUUID();console.error(`Writing Task 1 API error request_id=${requestId} type=${error?.name||'Error'} code=${error?.code||'none'}`);return r.status(500).json({ok:false,error:'INTERNAL_ERROR',requestId});});return app;
}
