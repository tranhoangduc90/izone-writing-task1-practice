import express from 'express';
import crypto from 'node:crypto';
import {z} from 'zod';
import {createApp} from '../../src/app.js';
import {loadConfig} from '../../src/config.js';
import {createDatabasePool} from '../../src/db.js';
import {createWritingPracticeService} from '../../src/service.js';
import {createLessonPracticeService} from '../../src/lesson-service.js';
import {createTeacherAuthService} from '../../src/teacher-auth.js';
import {createTeacherCommentService} from '../../src/teacher-comment-service.js';
import {createLmsResultService} from '../../src/lms-result-service.js';
import {createLesson9Service} from '../../src/lesson9-service.js';
import {createTeacherClassAccessService} from '../../src/teacher-class-access.js';
import {createProvisionalStudentService} from '../../src/provisional-service.js';
import {createLesson9VocabularyService} from '../../src/lesson9-vocabulary.js';
import {createShopsResults,installShopsResultRoutes} from './atomic-results.mjs';

const config=loadConfig();
if(config.nodeEnv!=='production'||!new URL(config.databaseUrl).pathname.endsWith('/shops_writing'))throw Error('SHOPS_PRODUCTION_DATABASE_REQUIRED');
const pool=createDatabasePool(config),provisionalService=createProvisionalStudentService({pool,pepper:config.provisionalStudentPinPepper}),lessonService=createLessonPracticeService({pool,provisionalService});
const service=createWritingPracticeService({pool,provisionalService}),teacherAuth=createTeacherAuthService({pool,config});
const vocabularyService=createLesson9VocabularyService({pool});
const lesson9=createLesson9Service({pool,lessonService,vocabularyService}),access=createTeacherClassAccessService({pool});
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'128kb'}));
// The reusable router never exposes another product's internal consumer.
app.use((q,r,next)=>q.path.startsWith('/api/v1/internal/')&&!q.path.startsWith('/api/v1/internal/grading-jobs/')?r.sendStatus(404):next());
app.use((q,r,next)=>{
 const origin=q.get('origin');r.set('Cache-Control','no-store');
 if(origin&&config.allowedOrigins.has(origin)){r.set('Access-Control-Allow-Origin',origin);r.set('Access-Control-Allow-Credentials','true');r.vary('Origin');}
 if(q.method==='OPTIONS'){
  if(!config.allowedOrigins.has(origin))return r.sendStatus(403);
  r.set('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');r.set('Access-Control-Allow-Headers','Content-Type,X-Izone-Csrf');return r.sendStatus(204);
 }next();
});
// Bản sao bài thật chỉ dành cho GV đối chiếu. Khóa ghi ở server, và không lộ
// nội dung/roster lịch sử qua API học viên của URL HTTPS công khai.
app.use(async(q,r,next)=>{
 try{
  if(config.teacherSessionCookieSecure&&q.method==='GET'&&q.path==='/api/v1/activities/writing-task2-public-health-ban/roster'){
   const send=r.json.bind(r);r.json=data=>send({...data,classes:data.classes?.filter(c=>c.className!=='SHOPS-CU-READONLY')});
  }
  const session=q.path.match(/\/(?:lesson9\/sessions|lesson-sessions|sessions)\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];
  const attempt=q.path.match(/\/attempts\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];
  const thread=q.path.match(/\/teacher-comments\/([0-9a-f-]{36})(?:\/|$)/i)?.[1];
  const classRef=q.body?.classRef;
  if(!session&&!attempt&&!thread&&!classRef)return next();
  const found=await pool.query(`SELECT s.public_id AS ref FROM writing_practice.activity_session s
   JOIN writing_practice.activity_class_scope c ON c.id=s.activity_class_id
   WHERE c.class_name_snapshot='SHOPS-CU-READONLY' AND (s.public_id=$1 OR c.public_id=$2
    OR EXISTS(SELECT 1 FROM writing_practice.check_attempt a WHERE a.session_id=s.id AND a.public_id=$3)
    OR EXISTS(SELECT 1 FROM writing_practice.teacher_comment_thread t WHERE t.session_id=s.id AND t.public_id=$4)) LIMIT 1`,[session||null,classRef||null,attempt||null,thread||null]);
  if(!found.rowCount)return next();
  if(!['GET','HEAD'].includes(q.method))return r.status(403).json({ok:false,error:'HISTORICAL_COPY_READ_ONLY',message:'Bản sao bài cũ chỉ để giảng viên đọc đối chiếu.'});
  if(!config.teacherSessionCookieSecure||q.path.startsWith('/api/v1/admin/'))return next();
  teacherAuth.authenticate(q,r,()=>void access.assertSession(q.reviewer,found.rows[0].ref).then(()=>next(),next));
 }catch(error){next(error);}
});
// Source bridge for the central teacher SSO; authentication tables remain owned.
app.post('/api/v1/auth/session/shared-session',async(q,r,next)=>{
 try{
  const result=await fetch('http://izone-teacher-session:8962/v1/source/shops',{method:'POST',headers:{'Content-Type':'application/json','X-Izone-Csrf':q.get('x-izone-csrf')||'',Origin:q.get('origin')||'',Cookie:q.get('cookie')||''},body:JSON.stringify(q.body||{}),signal:AbortSignal.timeout(15000),redirect:'error'});
  for(const cookie of result.headers.getSetCookie())r.append('Set-Cookie',cookie);
  r.status(result.status).type('application/json').send(await result.text());
 }catch(error){next(error);}
});
app.get('/api/v1/auth/config',(_q,r)=>r.json({ok:true,googleClientId:config.googleClientId,sharedSession:true,source:'shops'}));
const safe=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
app.use((q,r,next)=>{if(q.method!=='GET'&&q.get('origin')&&!config.allowedOrigins.has(q.get('origin')))return r.status(403).json({ok:false,error:'ORIGIN_DENIED'});next();});
app.post('/api/v1/lesson9/sessions',safe(async(q,r)=>{
 const input=z.object({activitySlug:z.literal('writing-task2-public-health-ban'),classRef:z.uuid(),studentRef:z.uuid(),accessCode:z.string().regex(/^\d{4}$/).optional()}).parse(q.body);
 r.status(201).json({ok:true,session:await lesson9.open(input)});
}));
app.get('/api/v1/lesson9/sessions/:ref',safe(async(q,r)=>r.json({ok:true,session:await lesson9.details(z.uuid().parse(q.params.ref))})));
app.post('/api/v1/lesson9/sessions/:ref/vocabulary',safe(async(q,r)=>{
 const ref=z.uuid().parse(q.params.ref),input=z.object({requestId:z.uuid(),retry:z.boolean().optional()}).parse(q.body);
 await vocabularyService.request({sessionRef:ref,...input});r.status(202).json({ok:true,session:await lesson9.details(ref)});void vocabularyService.tick();
}));
app.post('/api/v1/lesson9/sessions/:ref/actions',safe(async(q,r)=>{
 const input=z.object({baseVersion:z.number().int().nonnegative(),requestId:z.uuid(),kind:z.enum(['edit','open_idea2','copy_draft','attest','change_body','revise_draft']),field:z.string().max(80).optional(),value:z.string().max(20000).optional(),section:z.string().max(80).optional(),confirmed:z.boolean().optional()}).strict().parse(q.body);
 r.json({ok:true,session:await lesson9.action({sessionRef:z.uuid().parse(q.params.ref),...input})});
}));
app.get('/api/v1/admin/lesson9/sessions/:ref',teacherAuth.authenticate,safe(async(q,r)=>{
 const ref=z.uuid().parse(q.params.ref);await access.assertSession(q.reviewer,ref);r.json({ok:true,session:await lesson9.details(ref)});
}));
app.get('/api/v1/shops/status',safe(async(q,r)=>r.json({ok:true,environment:'production',aiMode:'n8n-task2-connected',database:(await pool.query('SELECT current_database() name')).rows[0].name,queued:Number((await pool.query("SELECT count(*) n FROM writing_practice.check_attempt a JOIN writing_practice.activity_session s ON s.id=a.session_id JOIN writing_practice.activity task ON task.id=s.activity_id WHERE a.status='queued' AND task.grading_pool='task2'")).rows[0].n)})));
const shopsResults=createShopsResults({pool});
installShopsResultRoutes(app,shopsResults);
app.use(createApp({config,pool,service,lessonService,provisionalService,teacherAuth,adminAuth:teacherAuth.authenticate,teacherCommentService:createTeacherCommentService({pool}),lmsResultService:shopsResults}));
app.use((e,q,r,n)=>r.status(e.status||400).json({ok:false,error:e.code||'INVALID_REQUEST',message:e.status?e.message:'Yêu cầu không hợp lệ.'}));
app.listen(config.port,'0.0.0.0',()=>console.log('Shops Writing API ready'));
setInterval(()=>void vocabularyService.tick().catch(()=>console.error('Vocabulary test worker needs retry')),15000).unref();
