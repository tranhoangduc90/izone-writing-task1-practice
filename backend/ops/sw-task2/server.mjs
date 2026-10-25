import express from 'express';
import {z} from 'zod';
import {createApp} from '../../src/app.js';
import {loadConfig} from '../../src/config.js';
import {createDatabasePool} from '../../src/db.js';
import {createWritingPracticeService} from './service-runtime.js';
import {createLessonPracticeService} from '../../src/lesson-service.js';
import {createTeacherAuthService} from '../../src/teacher-auth.js';
import {createTeacherCommentService} from '../../src/teacher-comment-service.js';
import {createTeacherClassAccessService} from '../../src/teacher-class-access.js';
import {createProvisionalStudentService} from '../../src/provisional-service.js';
import {createLesson9Service} from './lesson9-service.js';
import {createLesson9VocabularyService} from './lesson9-vocabulary.js';
import {createShopsResults,installShopsResultRoutes} from './atomic-results.mjs';
import {createPreviewAuth} from './preview-auth.mjs';
import {requireLesson,ENABLED_LESSONS} from './lesson-config.mjs';
import {createArchiveRead} from './archive-read.mjs';

const config=loadConfig();
if(config.nodeEnv!=='production'||new URL(config.databaseUrl).pathname!=='/sw_task2_preview_20261025')throw Error('ISOLATED_SW_PREVIEW_DATABASE_REQUIRED');
const pool=createDatabasePool(config);
const provisionalService=createProvisionalStudentService({pool,pepper:config.provisionalStudentPinPepper});
const lessonService=createLessonPracticeService({pool,provisionalService});
const service=createWritingPracticeService({pool,provisionalService});
const nativeAuth=createTeacherAuthService({pool,config});
const teacherAuth=createPreviewAuth({pool,nativeAuth});
const access=createTeacherClassAccessService({pool});
const archiveRead=createArchiveRead({pool});
const vocabularyService=createLesson9VocabularyService({pool});
const lesson9=createLesson9Service({pool,lessonService,vocabularyService});
const app=express();app.disable('x-powered-by');app.use(express.json({limit:'128kb'}));
const safe=fn=>(q,r,next)=>Promise.resolve(fn(q,r,next)).catch(next);
app.use((q,r,next)=>{
 const origin=q.get('origin');r.set('Cache-Control','no-store');
 if(origin&&config.allowedOrigins.has(origin)){r.set('Access-Control-Allow-Origin',origin);r.set('Access-Control-Allow-Credentials','true');r.vary('Origin');}
 if(q.method==='OPTIONS'){
  if(!config.allowedOrigins.has(origin))return r.sendStatus(403);
  r.set('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');r.set('Access-Control-Allow-Headers','Content-Type,X-Izone-Csrf');return r.sendStatus(204);
 }
 if(!['GET','HEAD'].includes(q.method)&&origin&&!config.allowedOrigins.has(origin))return r.sendStatus(403);
 if(q.path.startsWith('/api/v1/internal/')&&!q.path.startsWith('/api/v1/internal/grading-jobs/'))return r.sendStatus(404);
 next();
});
// The source snapshot is readable only by an authorized teacher. Every archive
// mutation is blocked before reaching generic routes, including retry/comments.
app.use(safe(async(q,r,next)=>{
 const pathRefs=q.path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)||[];
 const bodyRefs=['sessionRef','classRef','studentRef','attemptRef','jobRef','threadRef'].map(k=>q.body?.[k]).filter(v=>typeof v==='string'&&z.uuid().safeParse(v).success);
 const refs=[...pathRefs,...bodyRefs];if(!refs.length)return next();
 if(!['GET','HEAD'].includes(q.method)){
  const archiveScope=await pool.query("SELECT 1 FROM writing_practice.activity_class_scope c JOIN writing_practice.sw_preview_scope p ON p.scope_id=c.id AND p.kind='archive' WHERE c.public_id=ANY($1::uuid[]) LIMIT 1",[refs]);
  if(archiveScope.rowCount)return r.status(403).json({ok:false,error:'ARCHIVE_READ_ONLY',message:'Bản sao dữ liệu cũ chỉ để đọc đối chiếu.'});
 }
 const found=await pool.query(`SELECT s.public_id AS ref FROM writing_practice.activity_session s
 JOIN writing_practice.sw_preview_scope p ON p.scope_id=s.activity_class_id AND p.kind='archive'
 JOIN writing_practice.activity_class_scope scope ON scope.id=s.activity_class_id
 WHERE s.public_id=ANY($1::uuid[]) OR scope.public_id=ANY($1::uuid[]) OR s.student_public_id=ANY($1::uuid[])
 OR EXISTS(SELECT 1 FROM writing_practice.check_attempt a WHERE a.session_id=s.id AND a.public_id=ANY($1::uuid[]))
 OR EXISTS(SELECT 1 FROM writing_practice.teacher_comment_thread t WHERE t.session_id=s.id AND t.public_id=ANY($1::uuid[])) LIMIT 1`,[refs]);
 if(!found.rowCount)return next();
 if(!['GET','HEAD'].includes(q.method))return r.status(403).json({ok:false,error:'ARCHIVE_READ_ONLY',message:'Bản sao dữ liệu cũ chỉ để đối chiếu; không sửa hoặc chấm lại.'});
 teacherAuth.authenticate(q,r,()=>void access.assertSession(q.reviewer,found.rows[0].ref).then(()=>next(),next));
}));
app.get('/api/v1/auth/config',(_q,r)=>r.json({ok:true,googleClientId:config.googleClientId,sharedSession:true,source:'shops',preview:true}));
app.get('/api/v1/sw/status',safe(async(_q,r)=>r.json({ok:true,environment:'isolated-preview',database:(await pool.query('SELECT current_database() name')).rows[0].name,aiMode:'sw-task2-native',enabledLessons:ENABLED_LESSONS,queued:Number((await pool.query("SELECT count(*) n FROM writing_practice.check_attempt WHERE status='queued'")).rows[0].n)})));
app.get('/api/v1/activities/:slug/roster',safe(async(q,r)=>{
 requireLesson(q.params.slug);
 const data=await service.getRoster(q.params.slug);
 const allowed=await pool.query("SELECT c.public_id FROM writing_practice.activity_class_scope c JOIN writing_practice.sw_preview_scope p ON p.scope_id=c.id AND p.kind='fixture'");
 const ids=new Set(allowed.rows.map(c=>c.public_id));
 r.json({...data,ok:true,classes:data.classes.filter(c=>ids.has(c.classRef))});
}));
app.get('/api/v1/admin/activities/:slug/roster',teacherAuth.authenticate,safe(async(q,r)=>{
 requireLesson(q.params.slug);r.json({ok:true,...await archiveRead.roster(q.params.slug,q.reviewer)});
}));
app.get('/api/v1/admin/live/activities/:slug',teacherAuth.authenticate,safe(async(q,r,next)=>{
 requireLesson(q.params.slug);if(!q.query.classRef)return next();
 const data=await archiveRead.live(q.params.slug,z.uuid().parse(q.query.classRef),q.reviewer);if(!data)return next();r.json(data);
}));
app.get('/api/v1/admin/activities/:slug/export.csv',teacherAuth.authenticate,safe(async(q,r,next)=>{
 requireLesson(q.params.slug);if(!q.query.classRef)return next();const data=await archiveRead.live(q.params.slug,z.uuid().parse(q.query.classRef),q.reviewer);if(!data)return next();
 const cell=v=>'"'+String(v??'').replace(/^[=+@-]/,"'$&").replaceAll('"','""')+'"';
 const rows=[['Họ và tên','Lớp','Tiến trình (%)','Số ô đã làm','Số phần đã đạt','Số lần Check'],...data.students.map(s=>[s.displayName,s.className,s.progressPercent,s.filledFields,s.passedSectionCount,s.checkCount])];
 r.type('text/csv; charset=utf-8').send('\ufeff'+rows.map(row=>row.map(cell).join(',')).join('\r\n'));
}));
async function details(ref){
 const s=await lesson9.details(ref);requireLesson(s.activitySlug);
 const kind=await pool.query('SELECT p.kind FROM writing_practice.activity_class_scope c JOIN writing_practice.sw_preview_scope p ON p.scope_id=c.id WHERE c.public_id=$1',[s.classRef]);
 return {...s,previewReadOnly:kind.rows[0]?.kind==='archive'};
}
app.post('/api/v1/lesson9/sessions',safe(async(q,r)=>{
 const input=z.object({activitySlug:z.enum(ENABLED_LESSONS),classRef:z.uuid(),studentRef:z.uuid(),accessCode:z.string().regex(/^\d{4}$/).optional()}).strict().parse(q.body);
 r.status(201).json({ok:true,session:await lesson9.open(input)});
}));
app.get('/api/v1/lesson9/sessions/:ref',safe(async(q,r)=>r.json({ok:true,session:await details(z.uuid().parse(q.params.ref))})));
app.get('/api/v1/admin/lesson9/sessions/:ref',teacherAuth.authenticate,safe(async(q,r)=>{
 const ref=z.uuid().parse(q.params.ref);await access.assertSession(q.reviewer,ref);r.json({ok:true,session:await details(ref)});
}));
app.post('/api/v1/lesson9/sessions/:ref/actions',safe(async(q,r)=>{
 const input=z.object({baseVersion:z.number().int().nonnegative(),requestId:z.uuid(),kind:z.enum(['edit','open_idea2','copy_draft','attest','change_body','revise_draft']),field:z.string().max(80).optional(),value:z.string().max(20000).optional(),section:z.string().max(80).optional(),confirmed:z.boolean().optional()}).strict().parse(q.body);
 r.json({ok:true,session:await lesson9.action({sessionRef:z.uuid().parse(q.params.ref),...input})});
}));
app.post('/api/v1/lesson9/sessions/:ref/vocabulary',safe(async(q,r)=>{
 const ref=z.uuid().parse(q.params.ref),input=z.object({requestId:z.uuid(),retry:z.boolean().optional()}).strict().parse(q.body);
 await vocabularyService.request({sessionRef:ref,...input});r.status(202).json({ok:true,session:await details(ref)});void vocabularyService.tick();
}));
const results=createShopsResults({pool});installShopsResultRoutes(app,results);
app.use(createApp({config,pool,service,lessonService,provisionalService,teacherAuth,adminAuth:teacherAuth.authenticate,teacherClassAccess:access,teacherCommentService:createTeacherCommentService({pool}),lmsResultService:results}));
app.use((e,q,r,_n)=>{console.error(e.code||e.name||'PREVIEW_ERROR');r.status(e.status||400).json({ok:false,error:e.code||'INVALID_REQUEST',message:e.status?e.message:'Yêu cầu không hợp lệ.'});});
app.listen(config.port,'0.0.0.0',()=>console.log('SW Task 2 isolated preview ready'));
setInterval(()=>void vocabularyService.tick().catch(()=>console.error('VOCABULARY_RETRY_REQUIRED')),15000).unref();
