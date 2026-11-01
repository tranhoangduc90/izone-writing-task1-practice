// HTTP/SSE thật với database và danh tính giả cách ly; không gọi Google/AI.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {createContext} from '../src/reading-listening67/authority/context.js';
import {createContextSnapshot} from '../src/reading-listening67/authority/context-contract.js';
import {createReading67WebIdentity} from '../src/reading-listening67/web-identity.js';
import {createReading67OwnerEntry,READING_ENTRY_HEADER} from '../src/reading-listening67/web-owner-entry.js';
import {createReading67WebStore} from '../src/reading-listening67/web-store.js';
import {createReading67WebRouter} from '../src/reading-listening67/web-routes.js';
import {createWebObservationHub} from '../src/reading-listening67/web-observation-hub.js';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const content={code:'synthetic-observation',version:'v1'},grader={pins:{sha256:'fixture-pin'},profile:{expected_target_ids:['answer']},inspectWeb:answers=>({parsed:{targets:[{target_id:'answer',source_text:answers.answer}]},completeness:{eligible_for_grading:true}})};
const body={answers:{answer:'Bài tự viết giữ nguyên'},notes:'Ghi chú riêng',annotations:[],flags:[]};
async function until(check,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('HTTP_OBSERVATION_TIMEOUT');}
async function fixture(t){
 const db=new PGlite();await db.exec(await fs.readFile(new URL('../ops/listening-homework67/schema.sql',import.meta.url),'utf8'));let now=Date.now(),googleA='google-'+A;
 const payload={apiVersion:1,productId:'PRODUCT-TERM-MINI-K67',classes:[{erp_course_class_id:'1124',erp_class_name_snapshot:'TESTA'}],students:[A,B].map((public_id,n)=>({public_id,erp_course_class_id:'1124',erp_student_contact_id:String(91+n),erp_student_name_snapshot:'Synthetic '+n,status:'approved'})),memberships:[A,B].map((_id,n)=>({erp_course_class_id:'1124',erp_student_contact_id:String(91+n),erp_student_name_snapshot:'Synthetic '+n,source_state:'active'})),accounts:[{email:'teacher@example.test',google_subject:'known-sub',display_name:'Synthetic teacher',role:'teacher',status:'active',can_access_all_classes:false}],access:[{reviewer_email:'teacher@example.test',erp_course_class_id:'1124'}]};
 const context=createContext({url:'http://synthetic',key:'fixture',clock:()=>now,fetcher:async()=>new Response(JSON.stringify(createContextSnapshot(payload,now)))});
 // Listening's native identity intentionally does not require a Classroom owner.
 const identity=createReading67WebIdentity({db,context,allowedClassIds:['1124'],clock:()=>now,cookiePath:'/api',verifyGoogle:async()=>({email:'teacher@example.test',sub:'known-sub',email_verified:true})});
 const source={async member(classId,studentRef){return {courseId:'classroom-synthetic',googleUserId:studentRef===A?googleA:'google-'+studentRef};}};
 const entry=createReading67OwnerEntry({db,identity,ownerSource:source,metadata:content,policy:{classId:'1124',classCode:'TESTA',courseId:'classroom-synthetic'}});
 const scopes=[A,B].map(ownerId=>({ownerId,courseId:'1124',...content}));
 for(const s of scopes){const target={classId:s.courseId,studentRef:s.ownerId,...content,courseId:'classroom-synthetic',courseWorkId:'work-synthetic',submissionId:'submission-'+s.ownerId,documentId:'synthetic-document-'+s.ownerId,tabId:'t.0',googleUserId:'google-'+s.ownerId};await db.query('INSERT INTO reading_listening67.web_homework_binding(id,owner_id,course_id,assignment_code,content_version,target) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),s.ownerId,s.courseId,s.code,s.version,target]);}
 const hub=createWebObservationHub({db,clock:()=>now,interval:30});db.webObservations=hub;
 const store=createReading67WebStore({db,grader,jobScope:content}),app=express();app.use('/api',createReading67WebRouter({store,content,grader,identity,authenticate:identity.authenticate,ownerEntry:entry}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));const base='http://127.0.0.1:'+server.address().port+'/api',streams=[];
 async function request(path,{method='GET',value,headers={},status=200}={}){const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...headers},...(value?{body:JSON.stringify(value)}:{})});const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return {data,response};}
 async function student(id){const {data}=await request('/student/login',{method:'POST',value:{studentRef:id,classId:'1124'}});return {Authorization:'Bearer '+data.token};}
 async function stream(path,headers){
  const controller=new AbortController(),response=await fetch(base+path,{headers,signal:controller.signal});assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/text\/event-stream/);
  const frames=[],errors=[],reader=response.body.getReader(),decoder=new TextDecoder();let buffer='';
  const done=(async()=>{try{while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let at;while((at=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,at);buffer=buffer.slice(at+2);const event=/^event: (.+)$/m.exec(frame)?.[1],data=/^data: (.+)$/m.exec(frame)?.[1];if(event&&data)frames.push({event,value:JSON.parse(data)});}}}catch(e){if(!controller.signal.aborted)errors.push(e);}})();
  const result={frames,errors,done,close:()=>controller.abort()};streams.push(result);return result;
 }
 t.after(async()=>{for(const s of streams)s.close();await hub.close();await Promise.all(streams.map(s=>s.done));await new Promise(resolve=>server.close(resolve));await db.close();});
 return {db,hub,store,scopes,payload,request,student,stream,advance(){now+=31000;},reassign(){googleA='another-google-owner';}};
}
async function complete(f){const s=f.scopes[0];await f.store.save(s,{baseRevision:0,mutationId:randomUUID(),body});const sent=await f.store.submit(s,{revision:1,requestId:randomUUID()}),job=await f.store.claim();await f.store.finish(job,{pins:grader.pins,context:{operationId:job.jobId,sourceDigest:job.inputHash},grading:{target_results:[{target_id:'answer',verdict:'correct'}]},feedback:{answer:{reason:'first'}}});return sent;}

test('Real HTTP stream keeps unchanged snapshots quiet, detects same-attempt result changes and resynchronizes after reconnect',async t=>{
 const f=await fixture(t),sent=await complete(f),headers=await f.student(A),selected='?attemptId='+sent.attemptId;
 const {data:config}=await f.request('/config');assert.equal(config.capabilities.stateStream,true);
 const stream=await f.stream('/events'+selected,headers);await until(()=>stream.frames.some(x=>x.event==='state'));const original=stream.frames[0].value;
 const count=f.hub.snapshot().scans;await until(()=>f.hub.snapshot().scans>=count+3);assert.equal(stream.frames.length,1);
 await f.db.query("UPDATE reading_listening67.web_result SET data=jsonb_set(data,'{feedback,answer,reason}',to_jsonb($2::text)) WHERE attempt_id=$1",[sent.attemptId,'updated without another draft revision']);
 await until(()=>stream.frames.length===2);assert.notEqual(stream.frames[1].value.resultRevision,original.resultRevision);assert.equal(stream.frames[1].value.draftRevision,original.draftRevision);
 const {data:status}=await f.request('/status'+selected,{headers});assert.equal(status.revision,stream.frames[1].value.revision);
 const other=await f.student(B);await f.request('/status'+selected,{headers:other,status:404});await f.request('/events'+selected,{headers:other,status:404});await f.request('/events',{status:401});
 stream.close();await stream.done;const resumed=await f.stream('/events'+selected,{...headers,'Last-Event-ID':'old-epoch:1'});await until(()=>resumed.frames.length===1);assert.equal(resumed.frames[0].value.resultRevision,status.resultRevision);assert.deepEqual(resumed.errors,[]);
});

test('Registry reassignment and native logout close only their student stream; teachers retain historical access until their class permission is revoked',async t=>{
 const f=await fixture(t),sent=await complete(f),a=await f.student(A),b=await f.student(B),withDocument={...a,[READING_ENTRY_HEADER]:'synthetic-document-'+A};
 const login=await f.request('/teacher/login',{method:'POST',value:{credential:'synthetic-valid-google-token',remember:true}}),cookie=login.response.headers.get('set-cookie').split(';')[0];
 const sa=await f.stream('/events?attemptId='+sent.attemptId,withDocument),sb=await f.stream('/events',b),teacher=await f.stream('/teacher/work/1124/'+A+'/events?attemptId='+sent.attemptId,{Cookie:cookie});
 await until(()=>[sa,sb,teacher].every(s=>s.frames.some(e=>e.event==='state')));
 f.reassign();await until(()=>sa.frames.some(e=>e.event==='access_revoked'));assert.equal(sa.frames.at(-1).value.code,'HOMEWORK_ENTRY_NOT_FOUND');assert.equal(sb.frames.some(e=>e.event==='access_revoked'),false);assert.equal(teacher.frames.some(e=>e.event==='access_revoked'),false);
 f.payload.memberships[0].source_state='missing';f.advance();const scans=f.hub.snapshot().scans;await until(()=>f.hub.snapshot().scans>=scans+2);assert.equal(teacher.frames.some(e=>e.event==='access_revoked'),false);
 const historical=await f.request('/teacher/work/1124/'+A+'/attempts/'+sent.attemptId,{headers:{Cookie:cookie}});assert.equal(historical.data.status,'done');
 await f.request('/student/logout',{method:'POST',headers:b,value:{}});await until(()=>sb.frames.some(e=>e.event==='access_revoked'));assert.equal(sb.frames.at(-1).value.code,'WEB_UNAUTHORIZED');
 f.payload.access=[];f.advance();await until(()=>teacher.frames.some(e=>e.event==='access_revoked'));assert.equal(teacher.frames.at(-1).value.status,403);assert.equal(f.hub.snapshot().connections,0);
});
