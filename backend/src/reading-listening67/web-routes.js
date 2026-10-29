/**
 * Nhận identity từ middleware máy chủ, không nhận owner từ JSON học viên.
 * Trả nháp/kết quả đúng phạm vi; lỗi CAS, thiếu bài và lỗi chấm có mã riêng.
 * Bộ route không tự mở đăng nhập giả; fixture chỉ có ở entrypoint thử localhost.
 */
import express from 'express';
import {z} from 'zod';
import {timingSafeEqual} from 'node:crypto';
import {WebGradingError} from './web-grader.js';
const makeSaveInput=(flagCount=4)=>z.object({baseRevision:z.number().int().nonnegative(),mutationId:z.uuid(),body:z.object({answers:z.record(z.string(),z.string().max(12000)),annotations:z.array(z.record(z.string(),z.unknown())).max(300),notes:z.string().max(16000),flags:z.array(z.number().int().min(1).max(flagCount)).max(flagCount)}).strict()}).strict();
const submitInput=z.object({revision:z.number().int().positive(),requestId:z.uuid()}).strict();
const id=z.uuid();
export function createReading67WebRouter({store,content,grader,authenticate,identity,config={},homework,registerCta,adminKey,practice}){
  const saveInput=makeSaveInput(config.flagCount||4);
  const questionNumbers=content.questions?.map(q=>q.number)||[1,2,3,4];
  const lessonSaveInput=content.type==='tfng'||content.type==='green-roofs'?saveInput.extend({body:saveInput.shape.body.extend({flags:z.array(z.number().int().refine(n=>questionNumbers.includes(n))).max(questionNumbers.length)})}):saveInput;
  const router=express.Router();router.use(express.json({limit:'250kb',strict:true}));
  const route=fn=>(q,r,next)=>Promise.resolve(fn(q,r)).catch(next);
  const parse=(schema,value)=>{const result=schema.safeParse(value);if(!result.success)throw new WebGradingError('WEB_INVALID_INPUT',400);return result.data;};
  const ref=z.object({classId:z.string().regex(/^-?[1-9]\d{0,18}$/),studentRef:z.uuid()}).strict();
  const makeScope=person=>({ownerId:person.ownerId,courseId:person.courseId,code:content.code,version:content.version});
  const scope=q=>makeScope(q.webIdentity);
  const requireOpen=()=>{if(config.studentsOpen===false)throw new WebGradingError('CLASS_NOT_OPEN',423);};
  if(registerCta){
    const text=z.string().trim().min(1).max(200);
    const ctaEvent=z.object({doc_id:z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),classroom_course_id:text,coursework_id:text,submission_id:text,student_id:text,class_name:text});
    router.post('/admin/register-cta',route(async(q,r)=>{
      const expected=Buffer.from(adminKey||''),actual=Buffer.from(String(q.headers.authorization||'').replace(/^Bearer /,''));
      if(expected.length<32||expected.length!==actual.length||!timingSafeEqual(actual,expected))throw new WebGradingError('WEB_UNAUTHORIZED',401);
      r.json({ok:true,...await registerCta(parse(ctaEvent,q.body))});
    }));
  }
  if(identity){
    router.get('/config',(_q,r)=>r.json({ok:true,version:4,autoRole:true,title:content.title,code:content.code,lesson:content.lesson||10,type:content.type||'materials',...config}));
    router.get('/classes',route(async(_q,r)=>r.json({ok:true,classes:await identity.classes()})));
    router.get('/classes/:classId/students',route(async(q,r)=>r.json({ok:true,students:await identity.roster(q.params.classId)})));
    const identityInput=z.object({studentRef:z.uuid().optional(),identity:z.object({authority:z.literal('erp-contact'),id:z.string().regex(/^[1-9]\d{0,18}$/)}).strict().optional(),classCode:z.string().regex(/^[A-Z0-9._-]{2,32}$/).optional()}).strict().refine(v=>!!v.studentRef!==!!v.identity);
    router.post('/identity/resolve',route(async(q,r)=>r.json(await identity.resolve(parse(identityInput,q.body)))));
    router.post('/student/login',route(async(q,r)=>{requireOpen();r.json(await identity.loginStudent(parse(ref,q.body)));}));
    router.post('/student/logout',route(async(q,r)=>{await identity.logoutStudent(q);r.json({ok:true});}));
    router.post('/teacher/login',route(async(q,r)=>r.json(await identity.loginTeacher(q,r,parse(z.object({credential:z.string().min(10).max(10000),remember:z.boolean().default(true)}).strict(),q.body)))));
    router.post('/teacher/logout',route(async(q,r)=>{if(q.headers['x-izone-csrf']!=='1')throw new WebGradingError('CSRF_REJECTED',403);await identity.logoutTeacher(q,r);r.json({ok:true});}));
    router.get('/teacher/classes',route(async(q,r)=>r.json({ok:true,classes:await identity.teacherClasses(q)})));
    router.get('/teacher/students/:classId',route(async(q,r)=>{await identity.authorizeTeacher(q,r,q.params.classId);r.json({ok:true,students:await identity.roster(q.params.classId)});}));
    const teacherScope=async(q,r)=>{const p=parse(ref,{classId:q.params.classId,studentRef:q.params.studentRef});await identity.authorizeTeacher(q,r,p.classId);return {...p,scope:makeScope({ownerId:p.studentRef,courseId:p.classId})};};
    router.get('/teacher/work/:classId/:studentRef',route(async(q,r)=>{const p=await teacherScope(q,r);const member=(await identity.roster(p.classId)).find(s=>s.studentRef===p.studentRef);r.json({ok:true,content,identity:{ownerId:p.studentRef,courseId:p.classId,name:member?.name||'Học viên không còn trong danh sách đang học',className:p.classId},draft:await store.draft(p.scope),attempts:await store.history(p.scope),archives:await store.archives(p.scope),firstCompleted:await store.firstCompleted(p.scope),readonly:true});}));
    router.get('/teacher/work/:classId/:studentRef/attempts/:id',route(async(q,r)=>{const p=await teacherScope(q,r);r.json({ok:true,...await store.attempt(p.scope,parse(id,q.params.id))});}));
    if(practice)router.get('/teacher/work/:classId/:studentRef/practice',route(async(q,r)=>{const p=await teacherScope(q,r);r.json(await practice.status(p.scope,q.query.attemptId?parse(id,q.query.attemptId):undefined));}));
  }
  router.use(async(q,r,next)=>{try{requireOpen();q.webIdentity=await authenticate(q);if(!q.webIdentity)throw new WebGradingError('WEB_UNAUTHORIZED',401);next();}catch(error){next(error);}});
  router.get('/lesson',route(async(q,r)=>r.json({ok:true,content,identity:q.webIdentity,grader:{hash:grader.pins.sha256,version:grader.pins.workflowVersion},mode:'local_test_real_grading'})));
  router.get('/draft',route(async(q,r)=>r.json({ok:true,...await store.draft(scope(q))})));
  if(practice){
    router.get('/practice',route(async(q,r)=>r.json(await practice.status(scope(q),q.query.attemptId?parse(id,q.query.attemptId):undefined))));
    router.post('/practice',route(async(q,r)=>r.status(202).json(await practice.save(scope(q),parse(z.object({url:z.string().min(1).max(500),requestId:z.uuid()}).strict(),q.body)))));
  }
  router.get('/homework',route(async(q,r)=>r.json({ok:true,...(homework?await homework.status(scope(q)):{status:'not_applicable'})})));
  router.put('/draft',route(async(q,r)=>r.json({ok:true,...await store.save(scope(q),parse(lessonSaveInput,q.body))})));
  router.post('/submit',route(async(q,r)=>r.status(202).json({ok:true,...await store.submit(scope(q),parse(submitInput,q.body))})));
  router.get('/attempts',route(async(q,r)=>r.json({ok:true,attempts:await store.history(scope(q)),archives:await store.archives(scope(q)),firstCompleted:await store.firstCompleted(scope(q))})));
  router.post('/reset',route(async(q,r)=>r.json({ok:true,...await store.reset(scope(q),parse(z.object({baseRevision:z.number().int().nonnegative(),mutationId:z.uuid()}).strict(),q.body))})));
  router.get('/attempts/:id',route(async(q,r)=>r.json({ok:true,...await store.attempt(scope(q),parse(id,q.params.id))})));
  router.use((error,_q,r,_next)=>{
    const known=error instanceof WebGradingError;
    r.status(known?error.status:error.type==='entity.parse.failed'?400:error.type==='entity.too.large'?413:503).json({ok:false,error:known?error.code:'WEB_UNAVAILABLE',...(known?{details:error.details}:{})});
  });return router;
}
