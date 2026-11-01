// Independent Listening Homework process; private rubric/config and its own DB.
import fs from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import {OAuth2Client} from 'google-auth-library';
import {createListeningHomeworkApp,DOC_CONTRACT,listeningProgressText,listeningCompletionText} from '../src/listening-homework67/app.js';
import {createListeningLessonRouter} from '../src/listening-homework67/lesson-router.js';
import {listeningSummary} from '../src/listening-homework67/grader.js';
import {createListeningContext} from '../src/listening-homework67/context.js';
import {sha256} from '../src/reading-listening67/web-grader.js';
import {createReading67WebIdentity} from '../src/reading-listening67/web-identity.js';
import {createReading67Postgres} from '../src/reading-listening67/web-postgres.js';
import {createReading67HomeworkRuntime} from '../src/reading-listening67/web-homework-runtime.js';
import {createReading67OwnerSource} from '../src/reading-listening67/web-owner-source.js';
const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
const local=config.mode==='local_fixture';
if(!local&&config.mode!=='production')throw Error('MODE_REQUIRED');
if(!Number.isInteger(config.port)||config.port<1024||!path.isAbsolute(config.lessonPath))throw Error('CONFIG_INVALID');
if(!local&&(config.authority.kind!=='http'||config.database?.kind!=='postgres'||!config.homework?.enabled||!config.sso?.bridgeUrl||config.allowAllCourse67!==true||!config.allowedClassIds?.length))throw Error('PRODUCTION_BOUNDARY_CONFIG_REQUIRED');
const lesson=JSON.parse(await fs.readFile(config.lessonPath,'utf8'));
const db=local?new (await import('@electric-sql/pglite')).PGlite(config.dataDir):createReading67Postgres({connectionString:(await fs.readFile(config.database.connectionFile,'utf8')).trim(),max:4,workCoordinatorEnabled:config.workCoordinatorEnabled===true});
if(!local){const role=(await db.query('SELECT current_database() AS db,current_user AS role,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];if(role.db!=='listening_homework67'||role.role!=='listening_homework67_app'||role.rolsuper||role.rolcreatedb||role.rolcreaterole)throw Error('OWN_DATABASE_ROLE_REQUIRED');}
// Migrations are operator actions in production. Never discover or migrate another DB.
if(local)await db.exec(await fs.readFile(new URL('../ops/listening-homework67/schema.sql',import.meta.url),'utf8'));
const context=local?createListeningContext({url:'http://fixture',key:'fixture',fetcher:async()=>{
 const payload=JSON.parse(await fs.readFile(config.authority.path,'utf8'));
 return new Response(JSON.stringify({...payload,capturedAt:new Date().toISOString(),sourceRevision:sha256(JSON.stringify(payload))}));
}}):createListeningContext({url:config.authority.url,key:(await fs.readFile(config.authority.keyFile,'utf8')).trim(),allowedClassIds:config.allowedClassIds});
const classIds=(await context.classes()).map(c=>c.id);
if(!classIds.length)throw Error('NO_COURSE67_CLASSES');
const allowedClassIds=local?config.allowedClassIds:classIds;
const ownerSource=config.owner?createReading67OwnerSource({context,allowedClassIds,url:config.owner.url,key:(await fs.readFile(config.owner.keyFile,'utf8')).trim()}):undefined;
const google=new OAuth2Client(config.googleClientId);
// Native study access uses approved UUID/ERP membership. A missing Classroom
// owner binding must not deny a valid learner the independent homework page;
// the Docs worker still verifies the stricter Google owner before every write.
const identity=createReading67WebIdentity({db,context,allowedClassIds,cookieName:'listening_homework_teacher',cookiePath:(config.publicPath||'')+'/api/listening-homework67',verifyGoogle:local?async credential=>{if(credential!=='fixture-teacher-allowed')throw Error('INVALID_FIXTURE');return {email:'teacher@example.test',sub:'fixture-google',email_verified:true};}:async credential=>(await google.verifyIdToken({idToken:credential,audience:config.googleClientId})).getPayload()});
const definitions=[{lesson,audio:JSON.parse(await fs.readFile(config.audioPath,'utf8')),homework:config.homework}];
for(const extra of config.additionalLessons||[]){
 if(!path.isAbsolute(extra.lessonPath)||!path.isAbsolute(extra.audioPath))throw Error('LESSON_PATH_INVALID');
 if(!local&&(!Array.isArray(extra.allowedClassIds)||!extra.allowedClassIds.length))throw Error('LESSON_CLASS_SCOPE_REQUIRED');
 definitions.push({lesson:JSON.parse(await fs.readFile(extra.lessonPath,'utf8')),audio:JSON.parse(await fs.readFile(extra.audioPath,'utf8')),homework:extra.homework,studentsOpen:extra.studentsOpen,allowedClassIds:extra.allowedClassIds});
}
if(new Set(definitions.map(d=>d.lesson.code)).size!==definitions.length)throw Error('DUPLICATE_LISTENING_LESSON');
// Keep the configured reasoning quality. The deadline stays below the 15-minute
// database lease while allowing long HIGH-reasoning responses to finish.
const provider=async({prompt,operationId})=>{const response=await fetch(config.ai.endpoint,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model_id:config.ai.model||'gemini-3.5-flash',prompt,anh_minh_hoa:'',operation_id:operationId,generation_config:{temperature:0,response_mime_type:'application/json'}}),signal:AbortSignal.timeout(600000)});if(!response.ok)throw Object.assign(Error('AI_HTTP_'+response.status),{code:'AI_HTTP_'+response.status});const text=await response.text();try{return JSON.parse(text);}catch{return {text};}};
const runtimes=[];
for(const definition of definitions){
 const lessonContext=definition.allowedClassIds&&!local?createListeningContext({url:config.authority.url,key:(await fs.readFile(config.authority.keyFile,'utf8')).trim(),allowedClassIds:definition.allowedClassIds}):context;
 const lessonIdentity=definition.allowedClassIds?createReading67WebIdentity({db,context:lessonContext,allowedClassIds:definition.allowedClassIds,cookieName:'listening_homework_teacher',cookiePath:(config.publicPath||'')+'/api/listening-homework67',verifyGoogle:local?async credential=>{if(credential!=='fixture-teacher-allowed')throw Error('INVALID_FIXTURE');return {email:'teacher@example.test',sub:'fixture-google',email_verified:true};}:async credential=>(await google.verifyIdToken({idToken:credential,audience:config.googleClientId})).getPayload()}):identity;
 const lessonOwner=definition.allowedClassIds&&config.owner?createReading67OwnerSource({context:lessonContext,allowedClassIds:definition.allowedClassIds,url:config.owner.url,key:(await fs.readFile(config.owner.keyFile,'utf8')).trim()}):ownerSource;
 const homeworkRuntime=definition.homework?.enabled?await createReading67HomeworkRuntime({config:definition.homework,db,content:definition.lesson,identity:lessonIdentity,ownerSource:lessonOwner,contract:DOC_CONTRACT,resultSummary:listeningSummary,progressText:listeningProgressText,completionText:listeningCompletionText}):null;
 if(!local&&!homeworkRuntime)throw Error('LESSON_HOMEWORK_REQUIRED');
 const runtime=createListeningHomeworkApp({db,lesson:definition.lesson,provider,model:config.ai.model||'gemini-3.5-flash',identity:lessonIdentity,homeworkRuntime,audio:definition.audio,origins:config.origins,studentsOpen:definition.studentsOpen??config.studentsOpen,googleClientId:config.googleClientId,fixture:local,ssoBridge:config.sso?async q=>fetch(config.sso.bridgeUrl,{method:'POST',headers:{'Content-Type':'application/json',Origin:q.headers.origin,'X-Izone-Csrf':'1',Cookie:q.headers.cookie||''},body:JSON.stringify(q.body||{}),signal:AbortSignal.timeout(10000)}):null});
 runtimes.push({...runtime,code:definition.lesson.code,homeworkRuntime});
}
const runtime={app:createListeningLessonRouter(runtimes,{defaultCode:lesson.code,aliases:{'67-listening-02':'67-listening-scandinavian-studies'}})};
if(local){runtime.app.use('/listening-homework',express.static(path.join(config.pagesPath,'listening-homework')));runtime.app.use('/shared',express.static(path.join(config.pagesPath,'shared')));runtime.app.use('/term-tests/shared',express.static(path.join(config.pagesPath,'term-tests/shared')));}
const mounted=express();mounted.use(config.publicPath||'/',runtime.app);
const server=mounted.listen(config.port,local?'127.0.0.1':'0.0.0.0',()=>{for(const r of runtimes){r.worker.start();r.homeworkRuntime?.start();}console.log(JSON.stringify({ready:true,product:'listening-homework67',port:config.port,fixture:local,classes:allowedClassIds.length,lessons:runtimes.map(r=>r.code)}));});
async function close(){server.close();for(const r of runtimes){await r.worker.close();await r.homeworkRuntime?.close();}await db.close();process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);
