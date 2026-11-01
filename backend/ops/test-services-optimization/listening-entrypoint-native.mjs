// Exact Listening entrypoint on a task-owned internal PostgreSQL; never use a learner database.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
import express from 'express';
const connection=process.env.TEST_SERVICES_DATABASE_URL,url=new URL(connection||'http://invalid');
if(url.pathname!=='/test_services_optimization_20261101'||!/^tsto-20261101-pg-[a-z0-9]+$/.test(url.hostname)||url.username!=='fixture')throw Error('ISOLATED_LISTENING_DATABASE_REQUIRED');
const hash=raw=>createHash('sha256').update(raw).digest('hex'),delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,ms=15000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await delay(30);}throw Error('LISTENING_ENTRYPOINT_WAIT_TIMEOUT');}

test('Exact Listening process: four pinned lessons, own native role, scoped receipts/queue/streams and Linux restart',{timeout:100000},async t=>{
 const admin=new pg.Pool({connectionString:connection,max:2}),children=[],streams=[];let own,authority;
 t.after(async()=>{for(const c of streams)c.abort();for(const c of children)if(c.exitCode===null&&!c.signalCode){c.kill('SIGTERM');await Promise.race([once(c,'exit'),delay(5000)]);if(c.exitCode===null&&!c.signalCode)c.kill('SIGKILL');}await own?.end();await admin.end();if(authority)await new Promise(r=>authority.close(r));});
 await admin.query('CREATE ROLE listening_homework67_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE');await admin.query('CREATE DATABASE listening_homework67 OWNER listening_homework67_app');
 const ownUrl=new URL(connection);ownUrl.username='listening_homework67_app';ownUrl.pathname='/listening_homework67';own=new pg.Pool({connectionString:ownUrl.href,max:3});await own.query(await fs.readFile(new URL('../listening-homework67/schema.sql',import.meta.url),'utf8'));
 assert.deepEqual((await own.query('SELECT current_database() db,current_user role,rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0],{db:'listening_homework67',role:'listening_homework67_app',rolsuper:false});
 const input=new URL('./fixtures/listening/',import.meta.url),manifest=JSON.parse(await fs.readFile(new URL('manifest.json',input),'utf8')),classes=[...new Set(manifest.lessons.flatMap(l=>l.allowedClassIds))];
 assert.equal(manifest.lessons.length,4);const people=classes.flatMap((classId,n)=>[0,1].map(k=>({public_id:randomUUID(),erp_course_class_id:classId,erp_student_contact_id:String(90000+n*2+k),erp_student_name_snapshot:'Synthetic '+n+'-'+k,status:'approved'})));
 const payload={apiVersion:1,productId:'PRODUCT-TERM-MINI-K67',classes:classes.map(id=>({erp_course_class_id:id,erp_class_name_snapshot:'SYNTHETIC-'+id,erp_course_id:'5'})),students:people,memberships:people.map(p=>({...p,source_state:'active'})),accounts:[{email:'teacher@example.test',google_subject:'fixture-subject',role:'teacher',status:'active',can_access_all_classes:true}],access:[]};
 const api=express();let authorityReads=0;api.get('/v1/snapshot',(q,r)=>{assert.equal(q.headers['x-k67-context-key'],'synthetic-native-authority');authorityReads++;r.json({...payload,capturedAt:new Date().toISOString(),sourceRevision:hash(JSON.stringify(payload))});});authority=api.listen(0,'127.0.0.1');await once(authority,'listening');
 const tmp='/tmp/listening-entrypoint-'+randomUUID();await fs.mkdir(tmp);await fs.writeFile(tmp+'/authority.key','synthetic-native-authority');await fs.writeFile(tmp+'/admin.key','synthetic-admin-key-never-production-'+randomUUID());await fs.writeFile(tmp+'/database.txt',ownUrl.href);await fs.writeFile(tmp+'/wrong-database.txt',connection);
 const home={enabled:true,homeworkLesson:2,googleAuth:{kind:'command',command:process.execPath,args:['-e','throw Error("EXTERNAL_DOC_AUTH_FORBIDDEN")']},owner:{kind:'http',url:'http://127.0.0.1:9/never-owner',keyFile:tmp+'/authority.key'},adminKeyFile:tmp+'/admin.key',pageBase:'https://synthetic.invalid/listening'};
 const definitions=[];
 for(const row of manifest.lessons){for(const kind of ['lesson','audio'])assert.equal(hash(await fs.readFile(new URL(row.name+'/'+kind+'.json',input))),row[kind+'Sha256']);definitions.push({lessonPath:new URL(row.name+'/lesson.json',input).pathname,audioPath:new URL(row.name+'/audio.json',input).pathname,allowedClassIds:row.allowedClassIds,homework:home});}
 const config={mode:'production',port:18772,publicPath:'/native-listening',workersEnabled:false,workCoordinatorEnabled:true,allowAllCourse67:true,allowedClassIds:classes,studentsOpen:true,origins:[],googleClientId:'synthetic.apps.googleusercontent.com',authority:{kind:'http',url:'http://127.0.0.1:'+authority.address().port,keyFile:tmp+'/authority.key'},database:{kind:'postgres',connectionFile:tmp+'/database.txt'},sso:{bridgeUrl:'http://127.0.0.1:9/never-sso'},ai:{endpoint:'http://127.0.0.1:9/never-ai',model:manifest.model},...definitions[0],additionalLessons:definitions.slice(1)};
 const base='http://127.0.0.1:18772/native-listening/api/listening-homework67';
 async function start(value,label){const file=tmp+'/'+label+'.json';await fs.writeFile(file,JSON.stringify(value));const c=spawn(process.execPath,['scripts/serve-listening-homework67.mjs',file],{stdio:['ignore','pipe','pipe']});children.push(c);c.output='';for(const stream of [c.stdout,c.stderr])stream.on('data',b=>{c.output=(c.output+b).slice(-16000);});return c;}
 async function ready(c){await until(()=>{if(c.exitCode!==null||c.signalCode)throw Error(c.output);return c.output.includes('"ready":true');});}
 async function stop(c){const done=once(c,'exit');c.kill('SIGTERM');c.kill('SIGTERM');await Promise.race([done,delay(7000).then(()=>{throw Error('LISTENING_LINUX_DRAIN_TIMEOUT');})]);assert.equal(c.exitCode,0,c.output);}
 async function call(route,row,{method='GET',token,cookie,body,status=200}={}){const target=new URL(base+route);target.searchParams.set('assignmentCode',row.code);const response=await fetch(target,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return {value,response};}
 const rejected=await start({...config,database:{kind:'postgres',connectionFile:tmp+'/wrong-database.txt'}},'bad-role');await until(()=>rejected.exitCode!==null);assert.notEqual(rejected.exitCode,0);assert.match(rejected.output,/OWN_DATABASE_ROLE_REQUIRED/);
 const first=await start(config,'first');await ready(first);const saved=[];
 const teacherToken=randomBytes(32).toString('base64url');await own.query("INSERT INTO reading_listening67.web_teacher_session(token_hash,email,google_subject,expires_at,absolute_expires_at,remembered) VALUES($1,'teacher@example.test','fixture-subject',now()+interval '90 days',now()+interval '365 days',true)",[hash(teacherToken)]);const cookie='listening_homework_teacher='+teacherToken;
 for(const row of manifest.lessons){
  const person=people.find(p=>p.erp_course_class_id===row.allowedClassIds[0]),metadata=(await call('/config',row)).value;assert.equal(metadata.code,row.code);assert.equal(metadata.capabilities.stateStream,true);assert.equal(metadata.capabilities.compactDraftAck,true);
  const token=(await call('/student/login',row,{method:'POST',body:{classId:person.erp_course_class_id,studentRef:person.public_id}})).value.token;
  const other=people.find(p=>p.erp_course_class_id!==person.erp_course_class_id);await call('/teacher/work/'+other.erp_course_class_id+'/'+other.public_id,row,{cookie,status:row.allowedClassIds.includes(other.erp_course_class_id)?200:403});
  await call('/teacher/work/999999999/'+person.public_id,row,{cookie,status:403});
  const content=(await call('/lesson',row,{token})).value.content;assert.equal(content.version,row.version);
  const body={answers:Object.fromEntries(content.items.map(item=>[item.id,'Synthetic text only for durable native queue.'])),notes:'Synthetic native note',annotations:[],flags:[]},mutation={baseRevision:0,mutationId:randomUUID(),body};
  const ack=(await call('/draft?ack=compact-v1',row,{token,method:'PUT',body:mutation})).value;assert.equal(ack.revision,1);assert.equal(Object.hasOwn(ack,'body'),false);const replay=(await call('/draft',row,{token,method:'PUT',body:mutation})).value;assert.deepEqual(replay.body,body);assert.equal(replay.revision,1);
  const requestId=randomUUID(),sent=(await call('/submit',row,{token,method:'POST',body:{revision:1,requestId},status:202})).value;assert.equal((await call('/submit',row,{token,method:'POST',body:{revision:1,requestId},status:202})).value.attemptId,sent.attemptId);
  const peer=people.find(p=>p.erp_course_class_id===person.erp_course_class_id&&p.public_id!==person.public_id),peerToken=(await call('/student/login',row,{method:'POST',body:{classId:peer.erp_course_class_id,studentRef:peer.public_id}})).value.token;await call('/attempts/'+sent.attemptId,row,{token:peerToken,status:404});
  const teacher=await call('/teacher/work/'+person.erp_course_class_id+'/'+person.public_id,row,{cookie});assert.equal(teacher.value.readonly,true);assert.deepEqual(teacher.value.draft.body,body);assert.ok(teacher.response.headers.get('set-cookie').includes('Path=/native-listening/api/listening-homework67'));
  await call('/submit',row,{cookie,method:'POST',body:{revision:1,requestId:randomUUID()},status:401});saved.push({row,token,body,attemptId:sent.attemptId});
 }
 const selected=saved[0],controller=new AbortController();streams.push(controller);const target=new URL(base+'/events');target.searchParams.set('assignmentCode',selected.row.code);target.searchParams.set('attemptId',selected.attemptId);const response=await fetch(target,{headers:{Authorization:'Bearer '+selected.token},signal:controller.signal});assert.equal(response.status,200);const reader=response.body.getReader(),frame=await reader.read(),text=new TextDecoder().decode(frame.value);assert.match(text,/event: state/);assert.ok(!text.includes('Synthetic text only'));
 await delay(1200);assert.equal((await own.query("SELECT count(*)::int n FROM reading_listening67.web_job WHERE status='queued'")).rows[0].n,4);await stop(first);
 await until(async()=> (await reader.read()).done);const second=await start(config,'second');await ready(second);
 for(const value of saved){const attempt=(await call('/attempts/'+value.attemptId,value.row,{token:value.token})).value;assert.equal(attempt.status,'queued');assert.deepEqual(attempt.snapshot,value.body);assert.deepEqual((await call('/draft',value.row,{token:value.token})).value.body,value.body);}
 assert.equal((await own.query('SELECT count(*)::int n FROM reading_listening67.web_attempt')).rows[0].n,4);assert.ok(authorityReads>=2);await stop(second);
});
