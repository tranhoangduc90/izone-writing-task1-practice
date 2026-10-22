/**
 * Máy chủ chặng 3 chỉ bind localhost. Đọc quyền Reading qua API V1 hoặc fixture
 * tách riêng; bài/phiên/kết quả chỉ ghi SQL local. Không bật writer Docs/VPS.
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
import {createReading67WebStore,createReading67WebWorker} from '../src/reading-listening67/web-store.js';
import {createReading67WebRouter} from '../src/reading-listening67/web-routes.js';
import {createReading67Postgres} from '../src/reading-listening67/web-postgres.js';
const run=promisify(execFile),config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
if(!['local_test','https_test'].includes(config.mode)||!path.isAbsolute(config.dataDir))throw Error('TEST_CONFIG_REQUIRED');
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
const context=createContext({url:'http://private-authority',key:'not-forwarded',fetcher:async()=>{const value=first||await source();first=null;return new Response(JSON.stringify(value.context));}});
const initial=await context.snapshot();
const googleClientId=fixtureAuthority?'':(await source()).googleClientId;
const oauth=new OAuth2Client(googleClientId);
const verifyGoogle=fixtureAuthority?async value=>{if(value!=='demo-teacher-allowed')throw Error('INVALID_DEMO_CREDENTIAL');return {email:'teacher@example.test',sub:'demo-google-subject',email_verified:true};}:async credential=>(await oauth.verifyIdToken({idToken:credential,audience:googleClientId})).getPayload();
await fs.mkdir(config.dataDir,{recursive:true});
const db=config.database?.kind==='postgres'?createReading67Postgres({connectionString:(await fs.readFile(config.database.connectionFile,'utf8')).trim()}):new (await import('@electric-sql/pglite')).PGlite(path.join(config.dataDir,'postgres'));
if(config.mode==='https_test'&&config.database?.kind!=='postgres')throw Error('HTTPS_TEST_REQUIRES_OWN_POSTGRES');
if(config.database?.kind!=='postgres')for(const name of ['web','identity'])await db.exec(await fs.readFile(new URL(`../../docs/migrations/2026-10-22-reading67-${name}.sql`,import.meta.url),'utf8'));
else{const role=(await db.query('SELECT current_database() AS db,current_user AS role,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0];if(role.db!=='reading67_preview_stage3'||role.role!=='reading67_preview_app'||role.rolsuper)throw Error('TEST_DATABASE_ROLE_REQUIRED');await db.query('SELECT 1 FROM reading_listening67.web_student_session LIMIT 1');}
const content=JSON.parse(await fs.readFile(config.contentPath,'utf8'));
const grader=await loadReading67WebGrader({snapshotPath:config.graderPath,expectedSha256:config.graderSha256});
const store=createReading67WebStore({db,grader});await store.recoverExpired();
const identity=createReading67WebIdentity({db,context,allowedClassIds:config.allowedClassIds||initial.classes.map(c=>c.erp_course_class_id),verifyGoogle,cookiePath:publicPath+'/api/reading-skills67'});
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
const worker=createReading67WebWorker({store,grader,onError:error=>console.error(JSON.stringify({event:'reading67_worker_error',code:error.code||'FAILED'}))});
const app=express();app.disable('x-powered-by');if(config.mode==='https_test')app.set('trust proxy',1);
const origins=config.origins||[`http://127.0.0.1:${port}`,`http://localhost:${port}`];
app.use((q,r,next)=>{
 r.set('Cache-Control','no-store');r.set('X-Content-Type-Options','nosniff');r.set('Referrer-Policy','no-referrer');
 if(q.headers.origin&&!origins.includes(q.headers.origin))return r.status(403).json({error:'ORIGIN_NOT_ALLOWED'});
 if(q.headers.origin){r.set('Access-Control-Allow-Origin',q.headers.origin);r.set('Vary','Origin');r.set('Access-Control-Allow-Credentials','true');}
 r.set('Access-Control-Allow-Headers','Content-Type, Authorization, X-Izone-Csrf');r.set('Access-Control-Allow-Methods','GET, POST, PUT, OPTIONS');
 if(q.method==='OPTIONS')return r.sendStatus(204);next();
});
app.use('/api',rateLimit({windowMs:60000,limit:1200,standardHeaders:'draft-8',legacyHeaders:false}));
app.use('/api/reading-skills67',createReading67WebRouter({store,content,grader,identity,authenticate:identity.authenticate,config:{demo,demoGoogle:fixtureAuthority,googleClientId,authority:fixtureAuthority?'fixture':config.demoStudentFixture?'Student fixtures; teacher live Reading V1':'Reading context V1',...(demo?{demoStudent:{classId:config.seed.classId,studentRef:config.seed.studentRef}}:{})}}));
const pages=path.resolve(config.pagesPath);
app.get('/reading-skills67/',(_q,r)=>r.sendFile(path.join(pages,'reading-skills67/index.html')));
app.use('/reading-skills67',express.static(path.join(pages,'reading-skills67'),{dotfiles:'deny',index:false}));
for(const name of ['student-identity.js','student-identity-client.js','student-identity-migration.js','course-student-identity.js'])app.get('/shared/'+name,(_q,r)=>r.sendFile(path.join(pages,'shared',name)));
for(const name of ['styles.css','annotations.js','explanation-dialog.css','term-style/computer-based.css'])app.get('/reading-practice/'+name,(_q,r)=>r.sendFile(path.join(pages,'reading-practice',name)));
app.use('/reading-practice/fonts',express.static(path.join(pages,'reading-practice/fonts'),{dotfiles:'deny',index:false}));
app.get('/health',async(_q,r)=>{try{await db.query('SELECT 1');r.json({ok:true,demo,authority:demo?'fixture':'live_context_read_only',productionChanged:false});}catch{r.sendStatus(503);}});
app.get('/favicon.ico',(_q,r)=>r.sendStatus(204));app.get('/',(_q,r)=>r.redirect(publicPath+'/reading-skills67/?server=1'));
const mounted=express();mounted.use(publicPath||'/',app);
const server=mounted.listen(port,config.mode==='https_test'?'0.0.0.0':'127.0.0.1',()=>{worker.start();console.log(JSON.stringify({ready:true,port,demo}));});
let closing=false;async function close(){if(closing)return;closing=true;server.close();await worker.close();await db.close();process.exit(0);}process.on('SIGINT',close);process.on('SIGTERM',close);
