// Actual entrypoint, pinned lesson inputs and native PostgreSQL; only a task-owned internal fixture.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import express from 'express';
import {createContextSnapshot} from '../../src/reading-listening67/authority/context-contract.js';

const connection=process.env.TEST_SERVICES_DATABASE_URL,adminUrl=new URL(connection||'http://invalid');
if(adminUrl.pathname!=='/test_services_optimization_20261101'||!/^tsto-20261101-pg-[a-z0-9]+$/.test(adminUrl.hostname)||adminUrl.username!=='fixture')throw Error('ISOLATED_ENTRYPOINT_DATABASE_REQUIRED');
const hash=value=>createHash('sha256').update(value).digest('hex');
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms=10000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await delay(25);}throw Error('ENTRYPOINT_WAIT_TIMEOUT');}

test('Actual Reading entrypoint: six pinned lessons, own non-superuser DB, permissions, streams and compatible restart',{timeout:90000},async t=>{
 const admin=new pg.Pool({connectionString:connection,max:2}),children=[],streams=[];let own,authority;
 t.after(async()=>{for(const s of streams)s.abort();for(const c of children)if(c.exitCode===null&&!c.signalCode){c.kill('SIGTERM');await Promise.race([once(c,'exit'),delay(4000)]);if(c.exitCode===null&&!c.signalCode)c.kill('SIGKILL');}await own?.end();await admin.end();if(authority)await new Promise(r=>authority.close(r));});
 assert.equal((await admin.query('SELECT current_database() name')).rows[0].name,'test_services_optimization_20261101');
 await admin.query('CREATE ROLE reading67_preview_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await admin.query('CREATE DATABASE reading67_preview_stage3 OWNER reading67_preview_app');
 const ownUrl=new URL(connection);ownUrl.username='reading67_preview_app';ownUrl.pathname='/reading67_preview_stage3';own=new pg.Pool({connectionString:ownUrl.href,max:3});
 await own.query(await fs.readFile(new URL('../listening-homework67/schema.sql',import.meta.url),'utf8'));await own.query(await fs.readFile(new URL('./fixtures/share-practice.sql',import.meta.url),'utf8'));
 assert.deepEqual((await own.query('SELECT current_user name,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0],{name:'reading67_preview_app',rolsuper:false});
 const owner=randomUUID(),other=randomUUID(),payload={apiVersion:1,productId:'PRODUCT-TERM-MINI-K67',classes:[{erp_course_class_id:'1124',erp_class_name_snapshot:'ENTRYPOINT FIXTURE'}],students:[owner,other].map((id,n)=>({public_id:id,erp_course_class_id:'1124',erp_student_contact_id:String(91+n),erp_student_name_snapshot:'Synthetic '+n,status:'approved'})),memberships:[91,92].map(n=>({erp_course_class_id:'1124',erp_student_contact_id:String(n),erp_student_name_snapshot:'Synthetic',source_state:'active'})),accounts:[{email:'teacher@example.test',google_subject:'fixture-subject',display_name:'Synthetic teacher',role:'teacher',status:'active',can_access_all_classes:false}],access:[{reviewer_email:'teacher@example.test',erp_course_class_id:'1124'}]};
 const app=express();let authorityReads=0;app.get('/v1/snapshot',(q,r)=>{assert.equal(q.headers['x-k67-context-key'],'synthetic-entrypoint-authority');authorityReads++;r.json(createContextSnapshot(payload));});authority=app.listen(0,'127.0.0.1');await once(authority,'listening');
 const input=new URL('./fixtures/reading/',import.meta.url),manifest=JSON.parse(await fs.readFile(new URL('manifest.json',input),'utf8')),tmp='/tmp/reading-entrypoint-'+randomUUID();await fs.mkdir(tmp);await fs.writeFile(tmp+'/authority.key','synthetic-entrypoint-authority');await fs.writeFile(tmp+'/database.txt',ownUrl.href);await fs.writeFile(tmp+'/wrong-database.txt',connection);
 const lessonConfig=row=>({route:row.route,kind:row.kind,studentsOpen:true,allowedClassIds:['1124'],contentPath:new URL(row.name+'/content.json',input).pathname,graderPath:new URL(row.name+'/grader.json',input).pathname,graderSha256:row.graderSha256,...(row.auditSha256?{auditPath:new URL(row.name+'/audit.json',input).pathname,auditSha256:row.auditSha256}:{})});
 const config={mode:'local_test',port:18771,dataDir:tmp+'/data',publicPath:'/entrypoint-fixture',workersEnabled:false,workCoordinatorEnabled:true,googleClientId:'synthetic.apps.googleusercontent.com',authority:{kind:'http',url:'http://127.0.0.1:'+authority.address().port,keyFile:tmp+'/authority.key'},allowedClassIds:['1124'],database:{kind:'postgres',connectionFile:tmp+'/database.txt'},pagesPath:'/app/fixture-pages',gradingValidation:{enabled:true},...lessonConfig(manifest[0]),additionalLessons:manifest.slice(1).map(lessonConfig)};
 const url='http://127.0.0.1:18771/entrypoint-fixture';
 async function start(value,name){const file=tmp+'/'+name+'.json';await fs.writeFile(file,JSON.stringify(value));const c=spawn(process.execPath,['scripts/serve-reading67-web.mjs',file],{stdio:['ignore','pipe','pipe']});children.push(c);c.stdoutText='';c.stderrText='';c.stdout.on('data',b=>{c.stdoutText=(c.stdoutText+b).slice(-16000);});c.stderr.on('data',b=>{c.stderrText=(c.stderrText+b).slice(-16000);});return c;}
 const wrong=await start({...config,database:{kind:'postgres',connectionFile:tmp+'/wrong-database.txt'}},'wrong-role');await once(wrong,'exit');assert.notEqual(wrong.exitCode,0);assert.match(wrong.stderrText,/TEST_DATABASE_ROLE_REQUIRED/);
 let child=await start(config,'current');await until(()=>{if(child.exitCode!==null)throw Error('ENTRYPOINT_EXIT:'+child.stderrText.slice(-1200));return child.stdoutText.includes('"ready":true');},20000);
 async function call(path,{base='',method='GET',body,token,cookie,status=200}={}){const r=await fetch(url+base+path,{method,headers:{'Content-Type':'application/json',...(token?{authorization:'Bearer '+token}:{}),...(cookie?{cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();assert.equal(r.status,status,JSON.stringify(value));return {value,response:r};}
 const health=(await call('/health')).value;assert.equal(health.demo,false);assert.equal(health.ok,true);
 const asset=await fetch(url+'/shared/test-state-observer.mjs');assert.equal(asset.status,200);assert.match(asset.headers.get('content-type'),/javascript/);assert.equal(hash(Buffer.from(await asset.arrayBuffer())),process.env.ENTRYPOINT_OBSERVER_SHA256);
 const api='/api/reading-skills67',login=(await call('/student/login',{base:api,method:'POST',body:{classId:'1124',studentRef:owner}})).value,loginOther=(await call('/student/login',{base:api,method:'POST',body:{classId:'1124',studentRef:other}})).value;
 const teacherToken=randomBytes(32).toString('base64url'),cookie='reading67_teacher='+teacherToken;await own.query("INSERT INTO reading_listening67.web_teacher_session VALUES($1,'teacher@example.test','fixture-subject',now()+interval '30 minutes',now()+interval '1 day',true)",[hash(teacherToken)]);
 const receipts=[];
 for(const row of manifest){
  const base=api+row.route,cfg=(await call('/config',{base})).value;assert.equal(cfg.capabilities.stateStream,true);assert.equal(cfg.capabilities.practiceState,row.kind==='matching_headings');assert.equal(cfg.demo,false);
  const lesson=(await call('/lesson',{base,token:login.token})).value.content;assert.equal(lesson.code,row.code);assert.equal(lesson.version,row.version);
  await call('/draft',{base,status:401});const body={answers:{},notes:'Native entrypoint note '+row.name,annotations:[],flags:[]},mutationId=randomUUID();
  if(row.kind==='matching_headings'){
   await call('/draft',{base,method:'PUT',token:login.token,body:{baseRevision:0,mutationId,body},status:422});
   await own.query("INSERT INTO reading_listening67.web_share_practice(id,owner_id,course_id,assignment_code,content_version,share_url,request_id,status,outcome) VALUES($1,$2,'1124',$3,$4,$5,$6,'accepted',$7)",[randomUUID(),owner,row.code,row.version,'https://chatgpt.com/share/'+randomUUID(),randomUUID(),{message:'Synthetic accepted prerequisite'}]);
  }
  const ack=(await call('/draft?ack=compact-v1',{base,method:'PUT',token:login.token,body:{baseRevision:0,mutationId,body}})).value;assert.equal(ack.revision,1);assert.equal(ack.body,undefined);
  const replay=(await call('/draft',{base,method:'PUT',token:login.token,body:{baseRevision:0,mutationId,body}})).value;assert.deepEqual(replay.body,body);assert.equal(replay.revision,1);
  const teacher=(await call('/teacher/work/1124/'+owner,{base,cookie}));assert.deepEqual(teacher.value.draft.body,body);assert.equal(teacher.value.readonly,true);assert.match(teacher.response.headers.get('set-cookie'),/HttpOnly/);assert.ok(teacher.response.headers.get('set-cookie').includes('Path=/entrypoint-fixture/api/reading-skills67'));
  await call('/teacher/work/1131/'+owner,{base,cookie,status:403});await call('/draft',{base,method:'PUT',cookie,body:{baseRevision:1,mutationId:randomUUID(),body},status:401});assert.equal((await call('/draft',{base,token:loginOther.token})).value.revision,0);
  const state=(await call('/status',{base,token:login.token})).value;assert.equal(state.draftRevision,1);if(row.kind==='matching_headings')assert.equal(state.practice.status,'accepted');receipts.push({base,row,body,mutationId});
 }
 const first=receipts[0],content=(await call('/lesson',{base:api,token:login.token})).value.content;
 const answers=Object.fromEntries(content.targets.filter(t=>t.kind!=='section').map(t=>[t.id,'Synthetic compression for entrypoint persistence, never a learner answer.']));
 const submittedBody={...first.body,answers};await call('/draft',{base:api,method:'PUT',token:login.token,body:{baseRevision:1,mutationId:randomUUID(),body:submittedBody}});const sent=(await call('/submit',{base:api,method:'POST',token:login.token,body:{revision:2,requestId:randomUUID()},status:202})).value;assert.equal(sent.status,'queued');await call('/attempts/'+sent.attemptId,{base:api,token:loginOther.token,status:404});
 // A live fetch stream is kept open across SIGTERM to verify the real close path.
 const controller=new AbortController();streams.push(controller);const event=await fetch(url+api+'/events?attemptId='+sent.attemptId,{headers:{authorization:'Bearer '+login.token},signal:controller.signal});assert.equal(event.status,200);const reader=event.body.getReader();const firstFrame=await reader.read();assert.ok(firstFrame.value.length>0);
 child.kill('SIGTERM');await once(child,'exit');assert.equal(child.exitCode,0);controller.abort();await reader.cancel().catch(()=>{});
 assert.equal((await own.query('SELECT status FROM reading_listening67.web_job WHERE attempt_id=$1',[sent.attemptId])).rows[0].status,'queued');
 child=await start(config,'restarted');await until(()=>{if(child.exitCode!==null)throw Error('ENTRYPOINT_RESTART_EXIT:'+child.stderrText.slice(-1200));return child.stdoutText.includes('"ready":true');},20000);
 const restored=(await call('/attempts/'+sent.attemptId,{base:api,token:login.token})).value;assert.equal(restored.status,'queued');assert.deepEqual(restored.snapshot,submittedBody);assert.deepEqual((await call('/draft',{base:api,token:login.token})).value.body,submittedBody);
 for(const receipt of receipts.slice(1)){const replay=(await call('/draft',{base:receipt.base,method:'PUT',token:login.token,body:{baseRevision:0,mutationId:receipt.mutationId,body:receipt.body}})).value;assert.equal(replay.revision,1);assert.deepEqual(replay.body,receipt.body);}
 await call('/student/logout',{base:api,method:'POST',token:login.token,body:{}});for(const receipt of receipts)await call('/status',{base:receipt.base,token:login.token,status:401});
 assert.ok(authorityReads>=4);assert.equal((await own.query('SELECT count(*)::int n FROM reading_listening67.web_result')).rows[0].n,0);assert.equal((await own.query('SELECT count(*)::int n FROM reading_listening67.web_attempt')).rows[0].n,1);
 console.log('ACTUAL_ENTRYPOINT '+JSON.stringify({lessons:manifest.length,non_superuser:true,role_guard_rejected_admin:true,authority:'synthetic HTTP contract',google_verified:false,worker_mode:'disabled',compact_and_legacy_ack:true,restart_preserved_attempt:true,shared_asset_verified:true,production_services_changed:0}));
});
