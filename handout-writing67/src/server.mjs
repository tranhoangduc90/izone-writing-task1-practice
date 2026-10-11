import pg from 'pg';
import fs from 'node:fs';
import {OAuth2Client} from 'google-auth-library';
import {createTeacher} from './teacher.mjs';
import { createWake } from './wake.mjs';
import { promptRenderer } from './prompt.mjs';
import { config,rosterAdapter } from './config.mjs';
import { createStore,postgresAdapter } from './store.mjs';
import { createService } from './service.mjs';
import { createApi } from './http.mjs';
import {createProcessor,gatewayAdapter} from './processor.mjs';

// Chỉ mở tiến trình Handout 67. Không import app/server/notifier Writing hoặc biến env chung.
const settings=config();
const pool=new pg.Pool({connectionString:settings.databaseUrl,max:5,connectionTimeoutMillis:5000,statement_timeout:10000,idleTimeoutMillis:30000});
const target=await pool.query('SELECT current_database() AS db, current_user AS role');
if(target.rows[0].db!=='handout_writing67'||target.rows[0].role!=='handout67_runtime')throw new Error('Database thực tế sai đích.');
await pool.query('SELECT ref FROM handout67.session LIMIT 1');
const store=createStore(postgresAdapter(pool));
await pool.query('SELECT job_ref FROM handout67.grading_attempt LIMIT 1');
const renderJob=await promptRenderer(settings.promptFile,{classes:settings.classes}),lessons=renderJob.lessons;
const service=createService({store,roster:rosterAdapter(settings),secret:settings.secret,renderJob,lessons,retryDelays:[0,5000,15000]});
// Không có pump gọi AI nền; n8n phải chờ endpoint xử lý mỗi attempt để giữ trần chung.
const processor=createProcessor({service,callAI:gatewayAdapter(settings),onError:code=>console.error('Handout67: '+code)});
const wake=createWake({url:settings.wakeUrl,secret:settings.wakeSecret,hasWork:async()=>{const result=await pool.query("SELECT (j->>'jobRef') || ':' || COALESCE(j->>'tries','0') AS key FROM handout67.session s, jsonb_array_elements(s.payload->'jobs') j WHERE j->>'status'='queued' AND COALESCE((j->>'nextAttemptAt')::bigint,0)<=$1",[Date.now()]);return result.rows.map(r=>r.key);},onError:()=>console.error('Handout Writing 67: chưa đánh thức được đường chấm; job vẫn được giữ.')});
// Danh sách quyền lớp do Handout67 sở hữu; không đọc bảng tài khoản của hệ khác.
const oauth=new OAuth2Client();
oauth.transporter.defaults={...oauth.transporter.defaults,timeout:5000};
const registry=()=>{
  const value=JSON.parse(fs.readFileSync(settings.teacherFile,'utf8'));
  if(!value.clientId?.endsWith('.apps.googleusercontent.com')||!Array.isArray(value.teachers)||value.teachers.some(t=>typeof t.email!=='string'||typeof t.displayName!=='string'||typeof t.subject!=='string'||!t.subject.trim()||!Array.isArray(t.classes)||t.classes.some(c=>!settings.classes.includes(c))))throw new Error('TEACHER_REGISTRY_INVALID');
  return value;
};
if(settings.teacherFile)registry();
const teacher=settings.teacherFile?createTeacher({db:pool,store,roster:rosterAdapter(settings),registry,lessons,secret:settings.teacherSecret,verifyGoogleToken:async(token,audience)=>(await oauth.verifyIdToken({idToken:token,audience})).getPayload()}):null;
const server=createApi({service,teacher,processor,...settings});
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
async function stop(){if(closing)return;closing=true;wake.close();processor.close();clearInterval(sweepTimer);clearInterval(cleanupTimer);server.close(async()=>{await pool.end();process.exit(0);});setTimeout(()=>process.exit(1),210000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
