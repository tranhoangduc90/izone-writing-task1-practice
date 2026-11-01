// Chỉ được gọi sau schema của PostgreSQL fixture cách ly đã sẵn sàng.
import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createReading67Postgres} from '../../src/reading-listening67/web-postgres.js';
import {createReading67WebStore} from '../../src/reading-listening67/web-store.js';
import {createReading67WebIdentity} from '../../src/reading-listening67/web-identity.js';
import {createReading67OwnerEntry} from '../../src/reading-listening67/web-owner-entry.js';

export function registerObservationNativeTests({connectionString,grader,scope,save,submit,result,until}){
 test('Native observation batches 50 tabs at the real 1500-ms interval, detects an in-place result and revokes reassigned Docs without touching history',async()=>{
  const db=createReading67Postgres({connectionString,max:4,workCoordinatorEnabled:true});
  const a={...scope('native-observed'),courseId:'1124'},b={...a,ownerId:randomUUID()},metadata={code:a.code,version:a.version};
  const rows=[a,b].map((s,n)=>({public_id:s.ownerId,erp_course_class_id:'1124',erp_student_contact_id:String(91+n),erp_student_name_snapshot:'Synthetic '+n,status:'approved'}));
  const context={async snapshot(){return {classes:[{erp_course_class_id:'1124',erp_class_name_snapshot:'FIXTURE'}],students:rows,memberships:rows.map(r=>({erp_course_class_id:'1124',erp_student_contact_id:r.erp_student_contact_id,source_state:'active'}))};}};
  const identity=createReading67WebIdentity({db,context,allowedClassIds:['1124'],verifyGoogle:async()=>{throw Error('UNEXPECTED_GOOGLE_CALL');}}),store=createReading67WebStore({db,grader,jobScope:metadata});
  const entry=createReading67OwnerEntry({db,identity,metadata,policy:{classId:'1124',classCode:'FIXTURE',courseId:'fixture-classroom'}});
  const documentId='synthetic-native-document-'+a.ownerId,target={classId:a.courseId,studentRef:a.ownerId,...metadata,courseId:'fixture-classroom',courseWorkId:'fixture-work',submissionId:'fixture-submission',documentId,tabId:'t.0'},binding=randomUUID(),handles=[],frames=Array.from({length:50},()=>[]);
  let stateQueries=0,authQueries=0,documentQueries=0;
  const query=db.query;db.query=(sql,args)=>{if(sql.includes('WITH scopes AS'))stateQueries++;if(sql.includes("SELECT 'student' AS kind"))authQueries++;if(sql.includes('WITH docs AS'))documentQueries++;return query(sql,args);};
  try{
   await db.query('INSERT INTO reading_listening67.web_homework_binding(id,owner_id,course_id,assignment_code,content_version,target,sequence,last_doc_sequence) VALUES($1,$2,$3,$4,$5,$6,42,40)',[binding,a.ownerId,a.courseId,a.code,a.version,target]);
   for(let n=0;n<=42;n++)await db.query("INSERT INTO reading_listening67.web_homework_job(id,binding_id,event_key,sequence,kind,payload,status) VALUES($1,$2,$3,$4,$5,'{}',$6)",[randomUUID(),binding,'fixture-'+n,n,n===0?'cta':'status',n<41?'verified':n===41?'blocked':'pending']);
   await save(store,a,'saved before monitoring');const sent=await submit(store,a),job=await store.claim();await store.finish(job,result(job));
   const loginA=await identity.loginStudent({classId:'1124',studentRef:a.ownerId}),loginB=await identity.loginStudent({classId:'1124',studentRef:b.ownerId});
   const requestA={headers:{authorization:'Bearer '+loginA.token}},requestB={headers:{authorization:'Bearer '+loginB.token}};
   for(let n=0;n<50;n++){const isA=n!==49,s=isA?{...a,attemptId:sent.attemptId}:b,login=isA?loginA:loginB,request=isA?requestA:requestB;handles.push(db.webObservations.subscribe({scope:s,guard:identity.observeStudent(request,login.identity),document:isA?entry.observation(documentId,login.identity):undefined,send:(event,value)=>frames[n].push({event,value})}));}
   await until(()=>frames.every(f=>f.some(e=>e.event==='state')),10000);
   const before=db.webObservations.snapshot().scans;await until(()=>db.webObservations.snapshot().scans>=before+3,10000);
   assert.ok(frames.every(f=>f.length===1));assert.equal(stateQueries,db.webObservations.snapshot().scans);assert.equal(authQueries,stateQueries);assert.equal(documentQueries,stateQueries);
   assert.equal(frames[0][0].value.jobs.length,3);assert.equal(frames[0][0].value.documentSequence,42);assert.equal((await db.query('SELECT count(*)::int n FROM reading_listening67.web_homework_job WHERE binding_id=$1',[binding])).rows[0].n,43);
   const initial=frames[0][0].value;await db.query("UPDATE reading_listening67.web_result SET data=data||$2::jsonb WHERE attempt_id=$1",[sent.attemptId,JSON.stringify({fixtureRevision:'result changed in same attempt'})]);
   await until(()=>frames[0].length===2);assert.notEqual(frames[0][1].value.resultRevision,initial.resultRevision);assert.equal(frames[0][1].value.draftRevision,initial.draftRevision);
   await db.query('UPDATE reading_listening67.web_homework_binding SET target=$2 WHERE id=$1',[binding,{...target,studentRef:b.ownerId}]);
   await until(()=>frames.slice(0,49).every(f=>f.at(-1).event==='access_revoked'));assert.equal(db.webObservations.snapshot().connections,1);assert.equal(frames[49].some(e=>e.event==='access_revoked'),false);
   await identity.logoutStudent(requestB);await until(()=>frames[49].at(-1).event==='access_revoked');assert.equal(db.webObservations.snapshot().connections,0);
   assert.equal((await store.history(a)).length,1);assert.equal((await store.draft(a)).body.answers.answer,'saved before monitoring');assert.equal((await store.attempt(a,sent.attemptId)).status,'done');
   console.log('OBSERVATION_BATCH '+JSON.stringify({tabs:50,scans:stateQueries,queries_per_cycle:3,max_jobs_in_frame:3,interval_ms:1500}));
  }finally{for(const handle of handles)handle.close();await db.close();}
 });
}
