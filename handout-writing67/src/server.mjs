import pg from 'pg';
import fs from 'node:fs';
import {OAuth2Client} from 'google-auth-library';
import {createSharedTeacherVerifier} from './teacher-shared-session.mjs';
import {createTeacher} from './teacher.mjs';
import {validateTeacherRegistry} from './teacher-registry.mjs';
import { createWake } from './wake.mjs';
import {createNativeDispatch} from './native-dispatch.mjs';
import { promptRenderer } from './prompt.mjs';
import { config,rosterAdapter } from './config.mjs';
import {createLesson5CourseRoster,lesson5TeacherRegistry} from './lesson5-course-roster.mjs';
import { createStore,postgresAdapter } from './store.mjs';
import { createService } from './service.mjs';
import { createApi } from './http.mjs';
import {createProcessor,gatewayAdapter} from './processor.mjs';
import {createLesson4ShareWorker, lesson4ShareAnalyzer, lesson4ShareEnabled} from './writing-lesson4-share.mjs';
import {lesson6ShareEnabled} from './writing-lesson6.mjs';
import {LESSON6_RECOGNIZER_VERSION,lesson6ShareAnalyzer,verifyLesson6Conversation} from './writing-lesson6-share.mjs';
import {readSpeakingShare} from './vendor/chatgpt-share-reader.mjs';

// Chỉ mở tiến trình Handout 67. Không import app/server/notifier Writing hoặc biến env chung.
const settings=config();
const dispatchMode=process.env.HANDOUT67_DISPATCH_MODE||'n8n';
if(!['n8n','native'].includes(dispatchMode)) throw Error('HANDOUT67_DISPATCH_MODE_INVALID');
const nativeDispatch=dispatchMode==='native';
const pool=new pg.Pool({connectionString:settings.databaseUrl,max:5,connectionTimeoutMillis:5000,statement_timeout:10000,idleTimeoutMillis:30000});
const target=await pool.query('SELECT current_database() AS db, current_user AS role');
if(target.rows[0].db!=='handout_writing67'||target.rows[0].role!=='handout67_runtime')throw new Error('Database thực tế sai đích.');
await pool.query('SELECT ref FROM handout67.session LIMIT 1');
const reportWakeError=()=>console.error('Handout Writing 67: chưa đánh thức được đường chấm; job vẫn được giữ.');
const legacyWake=nativeDispatch?null:createWake({url:settings.wakeUrl,secret:settings.wakeSecret,hasWork:async()=>{const result=await pool.query("SELECT (j->>'jobRef') || ':' || COALESCE(j->>'tries','0') AS key FROM handout67.session s, jsonb_array_elements(s.payload->'jobs') j WHERE j->>'status'='queued' AND COALESCE((j->>'nextAttemptAt')::bigint,0)<=$1",[Date.now()]);return result.rows.map(r=>r.key);},onError:reportWakeError});
let wake=legacyWake;
const store=createStore(postgresAdapter(pool),{onQueueCommitted:()=>wake?.request?.(),onQueueError:reportWakeError});
await pool.query('SELECT job_ref FROM handout67.grading_attempt LIMIT 1');
const renderJob=await promptRenderer(settings.promptFile,{classes:settings.classes}),lessons=renderJob.lessons;
const staticRoster=rosterAdapter(settings);
const courseRosterPath=process.env.HANDOUT67_LESSON5_COURSE_ROSTER_FILE;
const lesson5CourseRoster=courseRosterPath?createLesson5CourseRoster(courseRosterPath,code=>console.error('Handout67: '+code)):()=>null;
if(courseRosterPath){
  const {classes,defaultClass}=lessons.lesson5;
  Object.defineProperties(lessons.lesson5,{
    classes:{enumerable:true,get:()=>lesson5CourseRoster()?.refs||classes},
    defaultClass:{enumerable:true,get(){return this.classes.includes(defaultClass)?defaultClass:this.classes[0];}},
  });
}
const roster=async(activity,scope)=>{
  if(activity==='lesson6'&&courseRosterPath){
    const current=lesson5CourseRoster();
    if(!current)throw Object.assign(new Error('ROSTER_UNAVAILABLE'),{status:503});
    return current.classes;
  }
  const snapshot=activity==='lesson5'?lesson5CourseRoster():null;
  return snapshot?snapshot.classes:staticRoster(activity,scope);
};
const writingEntryKey=process.env.HANDOUT67_WRITING_ENTRY_KEY_FILE?
  fs.readFileSync(process.env.HANDOUT67_WRITING_ENTRY_KEY_FILE,'utf8').trim():null;
if((lesson4ShareEnabled(lessons.lesson4)||lesson6ShareEnabled(lessons.lesson6))&&(!writingEntryKey||writingEntryKey.length<32||
  [settings.internalSecret,settings.secret].includes(writingEntryKey)))throw Error('WRITING_ENTRY_CONFIG_REQUIRED');
const service=createService({store,roster,secret:settings.secret,renderJob,lessons,
  lesson5HomeworkImport:process.env.HANDOUT67_LESSON5_HOMEWORK==='1',retryDelays:[0,5000,15000]});
// Không có pump gọi AI nền; n8n phải chờ endpoint xử lý mỗi attempt để giữ trần chung.
const callAI=gatewayAdapter(settings);
const processor=createProcessor({service,callAI,onError:code=>console.error('Handout67: '+code)});
if(nativeDispatch) {
  const capacity=Number(process.env.HANDOUT67_NATIVE_CAPACITY||1);
  wake=createNativeDispatch({
    service,processor,capacity,
    async hasWork() {
      const data=await pool.query(`SELECT 1 FROM handout67.session s
        CROSS JOIN LATERAL jsonb_array_elements(s.payload->'jobs') j
        WHERE (j->>'status'='queued' AND COALESCE((j->>'nextAttemptAt')::bigint,0)<=$1)
          OR (j->>'status'='leased' AND COALESCE((j->>'leaseUntil')::bigint,0)<=$1) LIMIT 1`,[Date.now()]);
      return data.rowCount>0;
    },
    onReceipt:receipt=>console.log(JSON.stringify({event:'handout67_native_receipt',...receipt})),
    onError:(error,detail)=>{
      const code=/^HANDOUT67_[A-Z0-9_]+$/.test(error?.message??'')?error.message:'HANDOUT67_NATIVE_FAILED';
      const candidate=error?.code??error?.cause?.code;
      const sqlState=/^(?:[0-9]{2}|[A-Z]{2})[0-9A-Z]{3}$/.test(candidate??'')?candidate:undefined;
      console.error(JSON.stringify({event:'handout67_native_error',code,sqlState,...detail}));
    }
  });
}
const shareWorkers=[
 lesson4ShareEnabled(lessons.lesson4)&&createLesson4ShareWorker({store,readShare:readSpeakingShare,analyze:lesson4ShareAnalyzer(callAI)}),
 lesson6ShareEnabled(lessons.lesson6)&&createLesson4ShareWorker({store,readShare:readSpeakingShare,analyze:lesson6ShareAnalyzer(callAI),
  activity:'lesson6',verify:verifyLesson6Conversation,recognizerVersion:LESSON6_RECOGNIZER_VERSION}),
].filter(Boolean);
let shareWorking=false;
async function checkShare(){
  if(shareWorking)return;
  shareWorking=true;
  try{
    for(const worker of shareWorkers)await worker().catch(()=>console.error('Handout67: WRITING_SHARE_WORKER_FAILED'));
  }
  finally{shareWorking=false;}
}
const shareTimer=shareWorkers.length?setInterval(checkShare,2000):null;
shareTimer?.unref();
// Grant hiện có thuộc Handout67. Chỉ Lesson 5 nhận thêm grant đã đối soát từ roster khóa 67.
const oauth=new OAuth2Client();
oauth.transporter.defaults={...oauth.transporter.defaults,timeout:5000};
const registry=()=>{
  const value=JSON.parse(fs.readFileSync(settings.teacherFile,'utf8'));
  return lesson5TeacherRegistry(validateTeacherRegistry(value,settings.classes),lesson5CourseRoster());
};
if(settings.teacherFile)registry();
const teacher=settings.teacherFile?createTeacher({db:pool,store,roster,registry,lessons,secret:settings.teacherSecret,verifyGoogleToken:async(token,audience)=>(await oauth.verifyIdToken({idToken:token,audience})).getPayload()}):null;
const ssoUrl=process.env.HANDOUT67_TEACHER_SSO_URL,ssoKeyFile=process.env.HANDOUT67_TEACHER_SSO_KEY_FILE;
if(Boolean(ssoUrl)!==Boolean(ssoKeyFile))throw Error('SSO_CONSUMER_CONFIG_REQUIRED');
const ssoBootstrapKey=ssoKeyFile?fs.readFileSync(ssoKeyFile,'utf8').trim():null;
const verifySharedTeacher=ssoUrl?createSharedTeacherVerifier({url:ssoUrl,key:ssoBootstrapKey}):null;
const server=createApi({service,teacher,processor,...settings,verifySharedTeacher,ssoBootstrapKey,writingEntryKey,
  nativeWake:nativeDispatch?wake.request:null,legacyWakeSecret:settings.wakeSecret});
let sweeping=false,cleaning=false;
async function sweep(){if(sweeping)return;sweeping=true;try{await service.sweep();}catch{console.error('Handout67: chưa kiểm được thời hạn lượt chấm.');}finally{sweeping=false;}}
async function cleanup(){
  if(cleaning)return;cleaning=true;
  try{for(let i=0;i<20;i++){const removed=await store.audit.cleanup(Date.now(),100);if(!removed)break;}}
  catch{console.error('Handout67: chưa dọn được nhật ký hết hạn; dữ liệu vẫn giữ.');}
  finally{cleaning=false;}
}
const sweepTimer=setInterval(sweep,15000),cleanupTimer=setInterval(cleanup,3600000);
sweepTimer.unref();cleanupTimer.unref();void sweep();void cleanup();
void wake.tick();
server.listen(settings.port,'0.0.0.0',()=>console.log('Handout Writing 67 đã sẵn sàng nhận HTTP.'));
let closing=false;
async function stop(){
  if(closing)return;
  closing=true;
  clearInterval(sweepTimer);clearInterval(cleanupTimer);clearInterval(shareTimer);
  setTimeout(()=>process.exit(1),210000).unref();
  const drained=wake.close();
  server.close(async()=>{await drained;processor.close();await pool.end();process.exit(0);});
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
