import express from 'express';
import helmet from 'helmet';
import {rateLimit,ipKeyGenerator} from 'express-rate-limit';
import {z} from 'zod';
import {ApiError} from './service.mjs';
const uuid=z.uuid(),section=z.enum(['overview','outline','draft']);
const snapshot=z.object({overview:z.string().max(20000),body1:z.string().max(20000),body2:z.string().max(20000),draft1:z.string().max(30000).default(''),draft2:z.string().max(30000).default('')}).strict();
const save=snapshot.extend({baseVersion:z.number().int().nonnegative(),requestId:uuid,draft2Unlocked:z.boolean().optional()});
const safe=f=>(q,r,n)=>Promise.resolve(f(q,r)).catch(n);
const parse=(s,x)=>s.parse(x);
export function createApp({config,pool,service,verifyTeacher}){
 const app=express();app.disable('x-powered-by');app.set('trust proxy',1);app.use(helmet());
 app.use((q,r,next)=>{
  r.set('Cache-Control','no-store');const origin=q.get('Origin');
  if(origin&&!config.origins.has(origin))return r.status(403).json({ok:false,error:'ORIGIN_DENIED'});
  if(origin){r.set('Access-Control-Allow-Origin',origin);r.set('Access-Control-Allow-Credentials','true');r.vary('Origin');}
  if(q.method==='OPTIONS')return r.set('Access-Control-Allow-Methods','GET,PUT,POST,OPTIONS').set('Access-Control-Allow-Headers','Content-Type').sendStatus(204);
  // Browser writes require an explicit allowed origin; server health/read calls may omit it.
  if(!['GET','HEAD'].includes(q.method)&&!origin)return r.status(403).json({ok:false,error:'ORIGIN_REQUIRED'});
  next();
 });
 app.use(rateLimit({windowMs:60000,limit:2400,standardHeaders:'draft-8',legacyHeaders:false}));
 app.use(express.json({limit:'128kb',strict:true}));
 const writes=rateLimit({windowMs:60000,limit:60,standardHeaders:'draft-8',legacyHeaders:false,keyGenerator:q=>q.params.ref||q.body?.studentRef||ipKeyGenerator(q.ip)});
 const teacher=(q,r,next)=>Promise.resolve().then(async()=>{
  if(!verifyTeacher)throw new ApiError(503,'SSO_UNAVAILABLE','Chưa xác minh được phiên giảng viên.');
  const id=await verifyTeacher(q);
  const result=await pool.query('SELECT * FROM task1_private.teacher_grant WHERE email=$1 AND google_subject=$2 AND active',[id.email.toLowerCase(),id.sub]);
  if(!result.rowCount)throw new ApiError(403,'TEACHER_FORBIDDEN','Tài khoản chưa có quyền trên hệ Task 1.');
  q.reviewer={...result.rows[0],canManage:result.rows[0].role==='admin'};
  next();
 }).catch(next);
 async function allowClass(q,classRef){
  if(q.reviewer.role!=='admin'&&!q.reviewer.class_refs.includes(classRef))throw new ApiError(403,'CLASS_FORBIDDEN','Không có quyền lớp này.');
 }
 async function allowSession(q,ref){
  const session=await service.sessionDetails(ref);await allowClass(q,session.classRef);return session;
 }
 async function allowThread(q,ref){
  const result=await pool.query('SELECT s.public_id AS ref FROM writing_practice.teacher_comment_thread t JOIN writing_practice.activity_session s ON s.id=t.session_id WHERE t.public_id=$1',[ref]);
  if(!result.rowCount)throw new ApiError(404,'THREAD_NOT_FOUND','Không tìm thấy trao đổi.');
  await allowSession(q,result.rows[0].ref);
 }
 app.get('/health',(_q,r)=>r.json({ok:true,productId:'sw-task1'}));
 app.get('/ready',safe(async(_q,r)=>{await pool.query('SELECT 1');r.json({ok:true,productId:'sw-task1'});}));
 app.get('/api/v1/activities/:slug/roster',safe(async(q,r)=>r.json({ok:true,...await service.getRoster(q.params.slug)})));
 app.post('/api/v1/activities/:slug/provisional-students',writes,safe(async(q,r)=>{
  const input=parse(z.object({classRef:uuid,displayName:z.string().min(2).max(100),pin:z.string().regex(/^\d{4}$/),requestId:uuid,duplicateConfirmed:z.boolean().optional()}).strict(),q.body);
  r.status(201).json({ok:true,...await service.provisional.createStudent({activitySlug:q.params.slug,...input})});
 }));
 app.post('/api/v1/sessions',writes,safe(async(q,r)=>r.status(201).json({ok:true,session:await service.openSession(parse(z.object({activitySlug:z.string().min(2).max(80),classRef:uuid,studentRef:uuid,accessCode:z.string().regex(/^\d{4}$/).optional()}).strict(),q.body))})));
 app.get('/api/v1/sessions/:ref',safe(async(q,r)=>r.json({ok:true,session:await service.sessionDetails(parse(uuid,q.params.ref))})));
 app.put('/api/v1/sessions/:ref/draft',writes,safe(async(q,r)=>r.json({ok:true,session:await service.saveDraft({sessionRef:parse(uuid,q.params.ref),...parse(save,q.body)})})));
 app.post('/api/v1/sessions/:ref/checks',writes,safe(async(q,r)=>r.status(202).json({ok:true,attempt:await service.submitCheck({sessionRef:parse(uuid,q.params.ref),...parse(z.object({section,requestId:uuid,snapshot}).strict(),q.body)})})));
 app.get('/api/v1/attempts/:ref',safe(async(q,r)=>r.json({ok:true,attempt:await service.getAttempt(parse(uuid,q.params.ref))})));
 app.post('/api/v1/attempts/:ref/retry',writes,safe(async(q,r)=>r.status(202).json({ok:true,attempt:await service.retryAttempt(parse(uuid,q.params.ref))})));
 app.put('/api/v1/sessions/:ref/live',writes,safe(async(q,r)=>r.json({ok:true,...await service.publishLive({sessionRef:parse(uuid,q.params.ref)})})));
 app.get('/api/v1/sessions/:ref/teacher-comments',safe(async(q,r)=>r.json({ok:true,...await service.comments.list({sessionRef:parse(uuid,q.params.ref)})})));
 const reply=z.object({body:z.string().trim().min(1).max(5000),requestId:uuid}).strict();
 app.post('/api/v1/sessions/:ref/teacher-comments/:thread/replies',writes,safe(async(q,r)=>r.status(201).json({ok:true,thread:await service.comments.reply({sessionRef:parse(uuid,q.params.ref),threadRef:parse(uuid,q.params.thread),actorRole:'student',actorRef:'student',...parse(reply,q.body)})})));
 app.get('/api/v1/admin/me',teacher,safe(async(q,r)=>{
  const classes=await pool.query("SELECT public_id AS \"classRef\",class_name_snapshot AS \"className\" FROM writing_practice.activity_class_scope WHERE status='active' AND ($1 OR public_id=ANY($2::uuid[]))",[q.reviewer.canManage,q.reviewer.class_refs]);
  r.json({ok:true,reviewer:{role:q.reviewer.role,canManage:q.reviewer.canManage},classes:classes.rows});
 }));
 app.get('/api/v1/admin/live/activities/:slug',teacher,safe(async(q,r)=>{
  const classRef=q.query.classRef?parse(uuid,q.query.classRef):null;if(classRef)await allowClass(q,classRef);
  const data=await pool.query(`SELECT s.public_id AS "sessionRef",c.public_id AS "classRef",c.class_name_snapshot AS "className",s.student_public_id AS "studentRef",r.display_alias AS "displayName",s.updated_at AS "updatedAt" FROM writing_practice.activity_session s JOIN writing_practice.activity a ON a.id=s.activity_id JOIN writing_practice.activity_class_scope c ON c.id=s.activity_class_id JOIN writing_practice.activity_roster r ON r.activity_class_id=c.id AND r.student_public_id=s.student_public_id WHERE a.slug=$1 AND ($2::uuid IS NULL OR c.public_id=$2) AND ($3 OR c.public_id=ANY($4::uuid[]))`,[q.params.slug,classRef,q.reviewer.canManage,q.reviewer.class_refs]);
  r.json({ok:true,students:data.rows,permissions:{canManage:q.reviewer.canManage}});
 }));
 app.get('/api/v1/admin/live/sessions/:ref',teacher,safe(async(q,r)=>r.json({ok:true,session:await allowSession(q,parse(uuid,q.params.ref))})));
 app.get('/api/v1/admin/live/sessions/:ref/teacher-comments',teacher,safe(async(q,r)=>{const ref=parse(uuid,q.params.ref);await allowSession(q,ref);r.json({ok:true,...await service.comments.list({sessionRef:ref})});}));
 app.post('/api/v1/admin/live/sessions/:ref/teacher-comments',writes,teacher,safe(async(q,r)=>{
  const ref=parse(uuid,q.params.ref);await allowSession(q,ref);
  const input=parse(z.object({sectionKey:section,fieldKey:z.enum(['overview','body1','body2','draft1','draft2']),start:z.number().int().nonnegative(),end:z.number().int().positive(),baseVersion:z.number().int().nonnegative(),body:z.string().trim().min(1).max(5000),requestId:uuid}).strict(),q.body);
  r.status(201).json({ok:true,thread:await service.comments.create({sessionRef:ref,actorRef:q.reviewer.email,...input})});
 }));
 app.post('/api/v1/admin/teacher-comments/:ref/replies',writes,teacher,safe(async(q,r)=>{const ref=parse(uuid,q.params.ref);await allowThread(q,ref);r.status(201).json({ok:true,thread:await service.comments.reply({threadRef:ref,actorRole:'teacher',actorRef:q.reviewer.email,...parse(reply,q.body)})});}));
 app.post('/api/v1/admin/teacher-comments/:ref/status',writes,teacher,safe(async(q,r)=>{const ref=parse(uuid,q.params.ref);await allowThread(q,ref);r.json({ok:true,thread:await service.comments.setStatus({threadRef:ref,actorRef:q.reviewer.email,...parse(z.object({status:z.enum(['open','addressed']),requestId:uuid}).strict(),q.body)})});}));
 app.post('/api/v1/admin/sessions/:ref/sections/:section/reopen',writes,teacher,safe(async(q,r)=>{
  const ref=parse(uuid,q.params.ref);await allowSession(q,ref);if(!q.reviewer.canManage)throw new ApiError(403,'ADMIN_REQUIRED','Cần quyền quản trị.');
  r.json({ok:true,session:await service.reopenSection({sessionRef:ref,section:parse(section,q.params.section),actorRef:q.reviewer.email,...parse(z.object({reason:z.string().trim().min(1).max(1000)}).strict(),q.body)})});
 }));
 // No public/internal queue consumer or callback route: the dedicated worker uses its own DB.
 app.use((_q,r)=>r.status(404).json({ok:false,error:'NOT_FOUND'}));
 app.use((e,_q,r,_n)=>r.status(e instanceof z.ZodError?400:e.status||500).json({ok:false,error:e instanceof z.ZodError?'INVALID_REQUEST':e.code||'INTERNAL_ERROR',message:e.status?e.message:'Yêu cầu chưa xử lý được.'}));
 return app;
}
