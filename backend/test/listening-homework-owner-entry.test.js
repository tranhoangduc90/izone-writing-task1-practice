import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import {createReading67OwnerEntry} from '../src/reading-listening67/web-owner-entry.js';
import {WebGradingError} from '../src/reading-listening67/web-grader.js';
import {createListeningLessonRouter} from '../src/listening-homework67/lesson-router.js';
const {createListeningHomeworkApp}=await import(process.env.LISTENING_APP_MODULE?pathToFileURL(process.env.LISTENING_APP_MODULE).href:'../src/listening-homework67/app.js');
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',header='X-Reading-Homework-Document';
const doc=(code,ref)=>`fixture-document-${code}-${ref===a?'owner-a':'owner-b'}`;
const lesson=code=>({code,version:'fixture-v1',title:code,homeworkLesson:8,minimumCompletion:.8,audioId:code+'-audio',groups:[],questions:[],items:[{id:'D1',group:'dictation',question:'Fixture question',answer:'fixture answer',core:'Fixture target',units:[{id:'D1.u1',meaning:'Fixture target'}]}]});
async function setup(t,{open=true,currentCourse=false}={}){
 const db=new PGlite();t.after(()=>db.close());await db.exec(await fs.readFile(new URL('../ops/listening-homework67/schema.sql',import.meta.url),'utf8'));
 const state={revoked:false,sourceFailed:false,teacherDenied:false,loginCount:0,ownerCourse:'fixture-classroom-course',ownerGoogle:'fixture-google-user'};
 const person=ref=>({ownerId:ref,courseId:'1293',name:ref===a?'Fixture A':'Fixture B',className:'IC2304'});
 const identity={
  member:async(c,ref)=>{if(state.revoked)throw new WebGradingError('STUDENT_ACCESS_DENIED',403);assert.equal(c,'1293');assert.ok([a,b].includes(ref));return person(ref);},
  authenticate:async q=>q.headers.authorization==='Bearer fixture-a'?person(a):q.headers.authorization==='Bearer fixture-b'?person(b):null,
  loginStudent:async({classId,studentRef})=>{state.loginCount++;return {token:'fixture-'+(studentRef===a?'a':'b'),identity:await identity.member(classId,studentRef)};},
  classes:async()=>[{id:'1293',classCode:'IC2304'}],roster:async()=>[a,b].map(studentRef=>({studentRef,name:person(studentRef).name})),
  authorizeTeacher:async q=>{if(q.headers.cookie!=='fixture-teacher=valid')throw new WebGradingError('TEACHER_LOGIN_REQUIRED',401);if(state.teacherDenied)throw new WebGradingError('ACCESS_DENIED',403);},
  teacherClasses:async q=>{await identity.authorizeTeacher(q);return [{id:'1293',classCode:'IC2304'}];}
 };
 const definitions=[lesson('67-listening-fixture-scandinavian'),lesson('67-listening-fixture-horton')],entries=[];
 for(const content of definitions){
  const metadata={code:content.code,version:content.version},policy={classes:[{classId:'1293',classCode:'IC2304',...(!currentCourse?{courseId:'fixture-classroom-course'}:{})}],...(currentCourse?{verifyCourseFromOwnerSource:true}:{})};
  const ownerSource={member:async()=>{if(state.sourceFailed)throw new WebGradingError('OWNER_SOURCE_UNAVAILABLE',503);return {courseId:state.ownerCourse,googleUserId:state.ownerGoogle};}};
  const ownerEntry=createReading67OwnerEntry({db,identity,metadata,policy,ownerSource});
  const runtime=createListeningHomeworkApp({db,lesson:content,identity,homeworkRuntime:{ownerEntry},provider:async()=>{throw Error('Entry must never call AI');},origins:['https://fixture.example'],studentsOpen:open,audio:{id:content.audioId}});
  for(const ref of [a,b]){
   const target={classId:'1293',studentRef:ref,...metadata,courseId:'fixture-classroom-course',courseWorkId:'fixture-work',submissionId:'fixture-submission',documentId:doc(content.code,ref),tabId:'t.0',googleUserId:'fixture-google-user'};
   await db.query('INSERT INTO reading_listening67.web_homework_binding(id,owner_id,course_id,assignment_code,content_version,target) VALUES($1,$2,$3,$4,$5,$6::jsonb)',[randomUUID(),ref,'1293',content.code,content.version,JSON.stringify(target)]);
   await runtime.store.save({ownerId:ref,courseId:'1293',...metadata},{baseRevision:0,mutationId:randomUUID(),body:{answers:{D1:ref===a?'Saved A':'Saved B'},annotations:[],notes:content.code,flags:[]}});
  }
  entries.push({...runtime,code:content.code});
 }
 return {db,state,definitions,api:request(createListeningLessonRouter(entries,{defaultCode:definitions[0].code,aliases:{old:definitions[0].code}})),prefix:'/api/listening-homework67'};
}

test('Both Homework lessons reject a foreign Doc before login, protected reads, writes or audio, and preserve native generic access',async t=>{
 const {db,state,definitions,api,prefix}=await setup(t),before=JSON.stringify((await db.query('SELECT * FROM reading_listening67.web_draft ORDER BY owner_id,assignment_code')).rows);
 for(const l of definitions){
  const suffix='?assignmentCode='+l.code,documentId=doc(l.code,b);
  const denied=await api.post(prefix+'/student/login'+suffix).set(header,documentId).send({classId:'1293',studentRef:a}).expect(403);assert.equal(denied.body.error,'HOMEWORK_ENTRY_OWNER_MISMATCH');assert.equal(state.loginCount,0);
  const resolved=await api.get(prefix+'/entry'+suffix+'&documentId='+documentId).expect(200);assert.equal(resolved.body.entry.studentRef,b);assert.equal(resolved.body.entry.code,l.code);
  for(const path of ['/lesson','/draft','/attempts','/homework','/audio']){
   const response=await api.get(prefix+path+suffix).set('Authorization','Bearer fixture-a').set('Cookie','fixture-teacher=valid').set(header,documentId).expect(403);
   assert.equal(response.body.error,'HOMEWORK_ENTRY_OWNER_MISMATCH');assert.equal(JSON.stringify(response.body).includes('Saved A'),false);
  }
  await api.put(prefix+'/draft'+suffix).set('Authorization','Bearer fixture-a').set(header,documentId).send({baseRevision:1,mutationId:randomUUID(),body:{answers:{D1:'Wrong owner write'},annotations:[],notes:'',flags:[]}}).expect(403);
  for(const path of ['/submit','/reset'])await api.post(prefix+path+suffix).set('Authorization','Bearer fixture-a').set(header,documentId).send({revision:1,requestId:randomUUID(),baseRevision:1,mutationId:randomUUID()}).expect(403);
  await api.get(prefix+'/draft'+suffix).set('Cookie','fixture-teacher=valid').set(header,documentId).expect(401);
  await api.get(prefix+'/draft'+suffix).set('Authorization','Bearer expired').set(header,documentId).expect(401);
  const own=await api.get(prefix+'/draft'+suffix).set('Authorization','Bearer fixture-b').set(header,documentId).expect(200);assert.equal(own.body.body.answers.D1,'Saved B');
  await api.get(prefix+'/draft'+suffix).set('Authorization','Bearer fixture-a').expect(200);
  await api.get(prefix+'/entry'+suffix+'&documentId='+doc(definitions.find(x=>x!==l).code,b)).expect(403);
 }
 assert.equal(JSON.stringify((await db.query('SELECT * FROM reading_listening67.web_draft ORDER BY owner_id,assignment_code')).rows),before);
 assert.equal((await db.query('SELECT count(*)::int n FROM reading_listening67.web_attempt')).rows[0].n,0);
 const cors=await api.options(prefix+'/entry').set('Origin','https://fixture.example').set('Access-Control-Request-Headers',header).expect(204);assert.match(cors.headers['access-control-allow-headers'],/X-Reading-Homework-Document/);
});

test('Wrong version, ambiguous targets, revoked membership and unavailable owner source block bound access; alias stays native',async t=>{
 const {db,state,definitions,api,prefix}=await setup(t),l=definitions[0],suffix='?assignmentCode='+l.code,documentId=doc(l.code,a);
 state.sourceFailed=true;await api.get(prefix+'/entry'+suffix+'&documentId='+documentId).expect(503);await api.get(prefix+'/draft'+suffix).set('Authorization','Bearer fixture-a').set(header,documentId).expect(503);state.sourceFailed=false;
 state.revoked=true;await api.get(prefix+'/entry'+suffix+'&documentId='+documentId).expect(403);state.revoked=false;
 await db.query("UPDATE reading_listening67.web_homework_binding SET target=jsonb_set(target,'{version}','\"wrong-version\"') WHERE target->>'documentId'=$1",[documentId]);
 await api.get(prefix+'/entry'+suffix+'&documentId='+documentId).expect(403);
 await db.query("UPDATE reading_listening67.web_homework_binding SET target=jsonb_set(target,'{version}','\"fixture-v1\"') WHERE target->>'documentId'=$1",[documentId]);
 await db.query("UPDATE reading_listening67.web_homework_binding SET target=jsonb_set(target,'{documentId}',to_jsonb($1::text)) WHERE owner_id=$2 AND assignment_code=$3",[documentId,b,l.code]);
 await api.get(prefix+'/entry'+suffix+'&documentId='+documentId).expect(403);
 assert.equal((await api.get(prefix+'/config?assignmentCode=old').expect(200)).body.code,l.code);
});

test('Teacher opens the registered Doc without a student session; native class permission, withdrawal history and closed lesson remain separate',async t=>{
 const {state,definitions,api,prefix}=await setup(t,{open:false});
 for(const l of definitions){
  const suffix='?assignmentCode='+l.code,documentId=doc(l.code,b),entry=prefix+'/teacher/entry'+suffix+'&documentId='+documentId;
  await api.get(entry).expect(401);state.teacherDenied=true;await api.get(entry).set('Cookie','fixture-teacher=valid').expect(403);state.teacherDenied=false;
  await api.get(prefix+'/entry'+suffix+'&documentId='+documentId).expect(423);
  state.revoked=true;
  const resolved=await api.get(entry).set('Cookie','fixture-teacher=valid').expect(200);assert.equal(resolved.body.entry.studentRef,b);
  const work=await api.get(prefix+'/teacher/work/1293/'+b+suffix).set('Cookie','fixture-teacher=valid').expect(200);assert.equal(work.body.identity.ownerId,b);assert.equal(work.body.readonly,true);assert.equal(work.body.draft.body.answers.D1,'Saved B');
  state.revoked=false;
 }
 assert.equal(state.loginCount,0);
});

test('Homework can verify the current Classroom course from its owner source without freezing a first student mapping into class policy',async t=>{
 const {state,definitions,api,prefix}=await setup(t,{currentCourse:true});
 for(const l of definitions){
  const url=prefix+'/entry?assignmentCode='+l.code+'&documentId='+doc(l.code,a);
  await api.get(url).expect(200);
  state.ownerCourse='different-course';await api.get(url).expect(403);state.ownerCourse='fixture-classroom-course';
  state.ownerGoogle='different-google-owner';await api.get(url).expect(403);state.ownerGoogle='fixture-google-user';
 }
 assert.throws(()=>createReading67OwnerEntry({policy:{verifyCourseFromOwnerSource:true,classes:[{classId:'1293',classCode:'IC2304'}]}}),/OWNER_ENTRY_SOURCE_REQUIRED/);
});
