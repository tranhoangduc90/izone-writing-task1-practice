import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import {createListeningHomeworkApp} from '../src/listening-homework67/app.js';
import {createListeningLessonRouter} from '../src/listening-homework67/lesson-router.js';
import {createReading67WebIdentity} from '../src/reading-listening67/web-identity.js';
const {createListeningGrader}=await import(process.env.LISTENING_GRADER_MODULE||'../src/listening-homework67/grader.js');
const lesson=(code,answer='fixture value')=>({code,version:'fixture-v1',title:code,homeworkLesson:8,minimumCompletion:.8,audioId:code+'-audio',groups:[],questions:[],items:[{id:'D2',group:'dictation',question:'Fixture question',answer,core:'Fixture meaning',units:[{id:'D2.u1',meaning:'Fixture target'}]}]});

test('D2 exact recognition belongs to its approved lesson, including spelling variants',()=>{
 const newer=createListeningGrader({lesson:lesson('fixture-new','numeric fixture')});
 assert.equal(newer.prepareWeb({D2:'specialized'}).pending.length,1);
 assert.equal(newer.prepareWeb({D2:'NUMERIC fixture.'}).pending.length,0);
 const original=createListeningGrader({lesson:lesson('fixture-old','specialised')});
 assert.equal(original.prepareWeb({D2:'specialized'}).pending.length,0);
});

test('Two lessons preserve separate drafts, jobs, results and teacher restrictions in one product DB',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(await fs.readFile(new URL('../ops/listening-homework67/schema.sql',import.meta.url),'utf8'));
 const who={ownerId:'11111111-1111-4111-8111-111111111111',courseId:'1293',name:'Fixture learner',className:'Fixture class'};
 const identity={authenticate:async q=>q.headers.authorization==='Bearer fixture-student'?who:null,classes:async()=>[],authorizeTeacher:async()=>{throw Object.assign(Error('Denied'),{status:403,code:'NO_PERMISSION'});}};
 const a=lesson('67-listening-fixture-a','fixture alpha'),b=lesson('67-listening-fixture-b','fixture beta');
 const runtimes=[a,b].map(l=>({...createListeningHomeworkApp({db,lesson:l,identity,provider:async()=>{throw Error('Exact fixture should not call AI');},origins:[],studentsOpen:true,audio:{id:l.audioId}}),code:l.code}));
 const app=createListeningLessonRouter(runtimes,{defaultCode:a.code,aliases:{old:a.code}}),api=request(app),prefix='/api/listening-homework67';
 await api.get(prefix+'/config?assignmentCode=unknown').expect(404);
 await api.get(prefix+'/config?assignmentCode=x&assignmentCode=y').expect(400);
 assert.equal((await api.get(prefix+'/config')).body.code,a.code);
 assert.equal((await api.get(prefix+'/config?assignmentCode=old')).body.code,a.code);
 assert.equal((await api.get(prefix+'/config?assignmentCode='+b.code)).body.code,b.code);
 const scopes=[a,b].map(l=>({...who,code:l.code,version:l.version}));
 for(let n=0;n<2;n++){
  const l=[a,b][n],url=prefix+'/draft?assignmentCode='+l.code;
  const saved=await api.put(url).set('Authorization','Bearer fixture-student').send({baseRevision:0,mutationId:randomUUID(),body:{answers:{D2:l.items[0].answer},annotations:[],notes:l.code,flags:[1]}}).expect(200);
  await api.post(prefix+'/submit?assignmentCode='+l.code).set('Authorization','Bearer fixture-student').send({revision:saved.body.revision,requestId:randomUUID()}).expect(202);
 }
 // B must never claim A, even though A was queued first.
 await runtimes[1].worker.tick();
 assert.equal((await runtimes[0].store.history(scopes[0]))[0].status,'queued');
 const doneB=(await runtimes[1].store.history(scopes[1]))[0];assert.equal(doneB.status,'done');
 await api.get(prefix+'/attempts/'+doneB.attemptId+'?assignmentCode='+a.code).set('Authorization','Bearer fixture-student').expect(404);
 await runtimes[0].worker.tick();
 for(let n=0;n<2;n++){
  const result=(await runtimes[n].store.history(scopes[n]))[0];assert.equal(result.status,'done');assert.equal(result.progress.correctCount,1);
  const l=[a,b][n];const draft=await api.get(prefix+'/draft?assignmentCode='+l.code).set('Authorization','Bearer fixture-student');assert.equal(draft.body.body.notes,l.code);
 }
 await api.put(prefix+'/draft?assignmentCode='+b.code).send({}).expect(401);
});

test('Each lesson retains its own class scope with shared product sessions',async t=>{
 const db=new PGlite();t.after(()=>db.close());await db.exec(await fs.readFile(new URL('../ops/listening-homework67/schema.sql',import.meta.url),'utf8'));
 const student='11111111-1111-4111-8111-111111111111';
 const snapshot={classes:['1293','1307'].map(id=>({erp_course_class_id:id,erp_class_name_snapshot:'Fixture '+id})),students:['1293','1307'].map(id=>({public_id:student,erp_course_class_id:id,erp_student_contact_id:'1',erp_student_name_snapshot:'Fixture',status:'approved'})),memberships:['1293','1307'].map(id=>({erp_course_class_id:id,erp_student_contact_id:'1',source_state:'active'}))};
 const context={snapshot:async()=>snapshot,classes:async()=>snapshot.classes.map(c=>({id:c.erp_course_class_id,classCode:c.erp_class_name_snapshot})),roster:async()=>[{studentRef:student,name:'Fixture'}],teacher:async()=>true};
 const identities=['1293','1307'].map(id=>createReading67WebIdentity({db,context,allowedClassIds:[id],verifyGoogle:async()=>({email:'teacher@example.test',sub:'fixture',email_verified:true})}));
 const definitions=[lesson('fixture-scope-old'),lesson('fixture-scope-new')];
 const entries=definitions.map((l,n)=>({...createListeningHomeworkApp({db,lesson:l,identity:identities[n],origins:[],studentsOpen:true,audio:{id:l.audioId}}),code:l.code}));
 const api=request(createListeningLessonRouter(entries,{defaultCode:definitions[0].code})),prefix='/api/listening-homework67';
 for(let n=0;n<2;n++){
  const code=definitions[n].code,classId=['1293','1307'][n],suffix='?assignmentCode='+code;
  assert.deepEqual((await api.get(prefix+'/classes'+suffix).expect(200)).body.classes.map(c=>c.id),[classId]);
  const login=await identities[n].loginStudent({classId,studentRef:student});
  await api.get(prefix+'/lesson'+suffix).set('Authorization','Bearer '+login.token).expect(200);
  await api.get(prefix+'/lesson?assignmentCode='+definitions[1-n].code).set('Authorization','Bearer '+login.token).expect(403);
  await api.get(prefix+'/audio?assignmentCode='+definitions[1-n].code).set('Authorization','Bearer '+login.token).expect(403);
 }
});
