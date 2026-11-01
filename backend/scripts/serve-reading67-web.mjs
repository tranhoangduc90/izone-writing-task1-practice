/**
 * Máy chủ thử riêng: đọc quyền Reading V1 hoặc fixture. Hàng Google Docs chỉ
 * bật khi cấu hình private chỉ rõ đích; không tự mở lớp hoặc nộp Classroom.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import express from 'express';
import {rateLimit} from 'express-rate-limit';
import {OAuth2Client} from 'google-auth-library';
import {createContext} from '../src/reading-listening67/authority/context.js';
import {createContextSnapshot,parseContextSnapshot} from '../src/reading-listening67/authority/context-contract.js';
import {createReading67WebIdentity} from '../src/reading-listening67/web-identity.js';
import {loadReading67WebGrader} from '../src/reading-listening67/web-grader.js';
import {createAdditionalReading67Lessons} from '../src/reading-listening67/web-additional-lessons.js';
import {createReading67WebStore,createReading67WebWorker} from '../src/reading-listening67/web-store.js';
import {createReading67WebRouter} from '../src/reading-listening67/web-routes.js';
import {createReading67Postgres} from '../src/reading-listening67/web-postgres.js';
import {createReading67HomeworkRuntime} from '../src/reading-listening67/web-homework-runtime.js';
import {createReading67CtaDispatcher} from '../src/reading-listening67/web-homework-cta.js';
import {createReading67OwnerSource} from '../src/reading-listening67/web-owner-source.js';
const run=promisify(execFile),config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
if(!['local_test','https_test','https_classroom'].includes(config.mode)||!path.isAbsolute(config.dataDir))throw Error('TEST_CONFIG_REQUIRED');
const classroom=config.mode==='https_classroom',https=config.mode!=='local_test';
if(classroom&&(config.authority.kind!=='http'||config.demoStudentFixture||config.seed||(!Array.isArray(config.allowedClassIds)||!config.allowedClassIds.length||config.allowedClassIds.some(id=>!/^\d+$/.test(id)))||config.homework?.owner?.kind!=='http'||config.homework.homeworkLesson!==10))throw Error('CLASSROOM_SCOPE_REQUIRED');
const publicPath=config.publicPath||'';
if(publicPath&&!/^\/[a-z0-9-]+$/.test(publicPath))throw Error('TEST_PUBLIC_PATH_INVALID');
const fixtureAuthority=config.authority.kind==='fixture',demo=fixtureAuthority||!!config.demoStudentFixture,port=config.port;
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('TEST_PORT_INVALID');
async function source(){
 if(fixtureAuthority){const payload=JSON.parse(await fs.readFile(config.authority.path,'utf8'));return {context:createContextSnapshot(payload),googleClientId:'demo-not-google'};}
 if(config.authority.kind==='http'){
  const key=(await fs.readFile(config.authority.keyFile,'utf8')).trim();
  const response=await fetch(config.authority.url.replace(/\/$/,'')+'/v1/snapshot',{headers:{'x-k67-context-key':key},signal:AbortSignal.timeout(5000)});
  if(!response.ok)throw Error('CONTEXT_UNAVAILABLE');let snapshot=await response.json();
  if(config.demoStudentFixture){
   const checked=parseContextSnapshot(snapshot),fixtures=JSON.parse(await fs.readFile(config.demoStudentFixture,'utf8'));
   if(fixtures.classes.some(c=>!checked.classes.some(real=>real.erp_course_class_id===c.erp_course_class_id)))throw Error('DEMO_CLASS_OUTSIDE_AUTHORITY');
   snapshot=createContextSnapshot({...fixtures,accounts:checked.accounts,access:checked.access.filter(a=>fixtures.classes.some(c=>c.erp_course_class_id===a.erp_course_class_id))},Date.parse(checked.capturedAt));
  }
  return {context:snapshot,googleClientId:config.googleClientId};
 }
 const result=await run(config.authority.command,config.authority.args,{timeout:25000,maxBuffer:2097152,windowsHide:true});return JSON.parse(result.stdout);
}
let first=await source();
const context=createContext({url:'http://private-authority',key:'not-forwarded',allowDiscoveredClasses:!!config.additionalLessons?.length,fetcher:async()=>{const value=first||await source();first=null;return new Response(JSON.stringify(value.context));}});
const initial=await context.snapshot();
const googleClientId=fixtureAuthority?'':(await source()).googleClientId;
const oauth=new OAuth2Client(googleClientId);
const verifyGoogle=fixtureAuthority?async value=>{if(value!=='demo-teacher-allowed')throw Error('INVALID_DEMO_CREDENTIAL');return {email:'teacher@example.test',sub:'demo-google-subject',email_verified:true};}:async credential=>(await oauth.verifyIdToken({idToken:credential,audience:googleClientId})).getPayload();
await fs.mkdir(config.dataDir,{recursive:true});
const db=config.database?.kind==='postgres'?createReading67Postgres({connectionString:(await fs.readFile(config.database.connectionFile,'utf8')).trim(),workCoordinatorEnabled:config.workCoordinatorEnabled===true}):new (await import('@electric-sql/pglite')).PGlite(path.join(config.dataDir,'postgres'));
if(https&&config.database?.kind!=='postgres')throw Error('HTTPS_TEST_REQUIRES_OWN_POSTGRES');
if(config.database?.kind!=='postgres')for(const name of ['web','identity',...(config.homework?.enabled?['homework']:[])])await db.exec(await fs.readFile(new URL(`../../docs/migrations/2026-10-22-reading67-${name}.sql`,import.meta.url),'utf8'));
if(config.database?.kind!=='postgres'&&config.gradingValidation?.enabled)await db.exec(await fs.readFile(new URL('../../docs/migrations/2026-10-26-reading67-validation.sql',import.meta.url),'utf8'));
if(config.database?.kind==='postgres'){const role=(await db.query('SELECT current_database() AS db,current_user AS role,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];if(role.db!==(classroom?'reading67_materials_ic2304':'reading67_preview_stage3')||role.role!==(classroom?'reading67_materials_app':'reading67_preview_app')||role.rolsuper)throw Error('TEST_DATABASE_ROLE_REQUIRED');await db.query('SELECT 1 FROM reading_listening67.web_student_session LIMIT 1');}
const content=JSON.parse(await fs.readFile(config.contentPath,'utf8'));
const managedCodes=[content.code,...await Promise.all((config.additionalLessons||[]).map(async lesson=>JSON.parse(await fs.readFile(lesson.contentPath,'utf8')).code))];
const grader=await loadReading67WebGrader({snapshotPath:config.graderPath,expectedSha256:config.graderSha256,validation:config.gradingValidation?.enabled===true});
const allowedClassIds=config.allowedClassIds||initial.classes.map(c=>c.erp_course_class_id);
if(allowedClassIds.some(id=>!initial.classes.some(c=>c.erp_course_class_id===String(id))))throw Error('LESSON_CLASSES_INVALID');
const ownerSource=config.homework?.owner?.kind==='http'?createReading67OwnerSource({context,allowedClassIds,url:config.homework.owner.url,key:(await fs.readFile(config.homework.owner.keyFile,'utf8')).trim()}):null;
const identity=createReading67WebIdentity({db,context,allowedClassIds,verifyGoogle,ownerSource,cookiePath:publicPath+'/api/reading-skills67',includeEmptyClasses:!!config.homework?.ownerEntry});
const homeworkRuntime=config.homework?.enabled?await createReading67HomeworkRuntime({config:config.homework,db,content,identity,ownerSource,managedCodes}):null;
const store=createReading67WebStore({db,grader,homework:homeworkRuntime?.homework,jobScope:{code:content.code,version:content.version}});await store.recoverExpired();
// Demo phát lại output AI thật đã lưu; qua cùng validator, không giả một kết quả mới.
if(demo&&config.seed){
 const scope={ownerId:config.seed.studentRef,courseId:config.seed.classId,code:content.code,version:content.version};
 if(!(await store.history(scope)).length){
  const value=JSON.parse(await fs.readFile(config.seed.attemptPath,'utf8'));
  const draft=await store.save(scope,{baseRevision:0,mutationId:crypto.randomUUID(),body:value.snapshot});
  await store.submit(scope,{revision:draft.revision,requestId:crypto.randomUUID()});const job=await store.claim();
  const response=JSON.parse(await fs.readFile(config.seed.responsePath,'utf8'));
  const result=await grader.finish(grader.prepareWeb(job.answers,job.jobId),{replayResponse:response});await store.finish(job,result);
 }
}
const additionalLessons=await createAdditionalReading67Lessons({configs:config.additionalLessons||[],db,context,initial,verifyGoogle,cookiePath:publicPath+'/api/reading-skills67',googleClientId,demo,managedCodes});
const ctaRegistrars=additionalLessons.map(l=>l.cta).filter(Boolean);
if(ctaRegistrars.some(c=>c.adminKey!==homeworkRuntime?.adminKey))throw Error('CTA_ADMIN_SCOPE_MISMATCH');
const registerCta=homeworkRuntime&&ctaRegistrars.length?createReading67CtaDispatcher({docs:homeworkRuntime.docs,registrars:[{code:content.code,registerCta:homeworkRuntime.registerCta},...ctaRegistrars]}):homeworkRuntime?.registerCta;
const worker=createReading67WebWorker({store,grader,onError:error=>console.error(JSON.stringify({event:'reading67_worker_error',code:error.code||'FAILED'}))});
const app=express();app.disable('x-powered-by');if(https)app.set('trust proxy',1);
const origins=config.origins||[`http://127.0.0.1:${port}`,`http://localhost:${port}`];
app.use((q,r,next)=>{
 r.set('Cache-Control','no-store');r.set('X-Content-Type-Options','nosniff');r.set('Referrer-Policy','no-referrer');
 if(q.headers.origin&&!origins.includes(q.headers.origin))return r.status(403).json({error:'ORIGIN_NOT_ALLOWED'});
 if(q.headers.origin){r.set('Access-Control-Allow-Origin',q.headers.origin);r.set('Vary','Origin');r.set('Access-Control-Allow-Credentials','true');}
 r.set('Access-Control-Allow-Headers','Content-Type, Authorization, X-Izone-Csrf, X-Reading-Homework-Document');r.set('Access-Control-Allow-Methods','GET, POST, PUT, OPTIONS');
 if(q.method==='OPTIONS')return r.sendStatus(204);next();
});
app.use('/api',rateLimit({windowMs:60000,limit:1200,standardHeaders:'draft-8',legacyHeaders:false}));
for(const lesson of additionalLessons)app.use('/api/reading-skills67'+lesson.route,lesson.router);
app.use('/api/reading-skills67',createReading67WebRouter({store,content,grader,identity,authenticate:identity.authenticate,ownerEntry:homeworkRuntime?.ownerEntry,homework:homeworkRuntime?.homework,registerCta,adminKey:homeworkRuntime?.adminKey,config:{studentsOpen:classroom?config.studentsOpen===true:true,homeworkEnabled:!!homeworkRuntime,homeworkMode:homeworkRuntime?.mode,demo,demoGoogle:fixtureAuthority,googleClientId,authority:fixtureAuthority?'fixture':config.demoStudentFixture?'Student fixtures; teacher live Reading V1':'Reading context V1',...(demo?{demoStudent:{classId:config.seed.classId,studentRef:config.seed.studentRef}}:{})}}));
const pages=path.resolve(config.pagesPath);
app.get('/reading-skills67/',(_q,r)=>r.sendFile(path.join(pages,'reading-skills67/index.html')));
app.use('/reading-skills67',express.static(path.join(pages,'reading-skills67'),{dotfiles:'deny',index:false}));
for(const name of ['student-identity.js','student-identity-client.js','student-identity-migration.js','course-student-identity.js'])app.get('/shared/'+name,(_q,r)=>r.sendFile(path.join(pages,'shared',name)));
for(const name of ['styles.css','annotations.js','explanation-dialog.css','term-style/computer-based.css'])app.get('/reading-practice/'+name,(_q,r)=>r.sendFile(path.join(pages,'reading-practice',name)));
app.use('/reading-practice/fonts',express.static(path.join(pages,'reading-practice/fonts'),{dotfiles:'deny',index:false}));
app.get('/health',async(_q,r)=>{try{await db.query('SELECT 1');r.json({ok:true,demo,studentsOpen:classroom?config.studentsOpen===true:true,authority:fixtureAuthority?'fixture':config.demoStudentFixture?'student_fixture_teacher_live':'live_context_read_only',homework:homeworkRuntime?.mode||'disabled',deployment:classroom?'IC2304 Lesson 10':'preview'});}catch{r.sendStatus(503);}});
app.get('/favicon.ico',(_q,r)=>r.sendStatus(204));app.get('/',(_q,r)=>r.redirect(publicPath+'/reading-skills67/?server=1'));
const mounted=express();mounted.use(publicPath||'/',app);
const server=mounted.listen(port,https?'0.0.0.0':'127.0.0.1',()=>{if(config.workersEnabled!==false){worker.start();homeworkRuntime?.start();for(const lesson of additionalLessons)lesson.start();}console.log(JSON.stringify({ready:true,port,demo,homework:homeworkRuntime?.mode||'disabled'}));});
let closing=false;async function close(){if(closing)return;closing=true;server.close();await worker.close();await homeworkRuntime?.close();for(const lesson of additionalLessons)await lesson.close();await db.close();process.exit(0);}process.on('SIGINT',close);process.on('SIGTERM',close);
