import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import {createListeningGrader,listeningSummary} from '../src/listening-homework67/grader.js';
import {LISTENING_SOURCE_VERSION,listeningEvidenceSource,materializeListeningSpans} from '../src/listening-homework67/source-references.js';
import {createListeningHomeworkApp,DOC_CONTRACT,listeningCompletionText} from '../src/listening-homework67/app.js';
import {createListeningContext} from '../src/listening-homework67/context.js';
import {sha256} from '../src/reading-listening67/web-grader.js';
import {createReading67WebIdentity} from '../src/reading-listening67/web-identity.js';
import {planReading67HomeworkWrite,locateReading67Homework} from '../src/reading-listening67/web-homework-docs.js';
const ids=['U1','U2','U3'];
const lesson={code:'67-listening-fixture',version:'fixture-v1',title:'Private fixture',homeworkLesson:2,minimumCompletion:.8,audioId:'fixture-audio',groups:[],questions:[],items:ids.map(id=>({id,group:'fixture',question:'Nêu ý fixture '+id,answer:'approved '+id,core:'Meaning '+id,accept:'Valid variants are open',reject:'Contradiction must be rejected',units:[{id:id+'.u1',meaning:'first'},{id:id+'.u2',meaning:'second'}]}))};
const answers=()=>Object.fromEntries(ids.map(id=>[id,'approved '+id]));
const row=(id,raw,statuses=['present','present'])=>({target_id:id,units:statuses.map((s,n)=>({unit_id:id+'.u'+(n+1),status:s,span:s==='present'||s==='contradicted'?raw:null})),contradiction:statuses.includes('contradicted'),meaning_errors:statuses.includes('contradicted')?[{kind:'other',span:raw,explanation:'Có khẳng định trái nghĩa trong câu trả lời.'}]:[],writing_notes:[],reason:'Nhận xét cụ thể về câu trả lời đang kiểm.',next_step:statuses.every(s=>s==='present')?'':'Lần sau, bổ sung ý còn thiếu và đối chiếu lại câu trả lời.'});
const review=(verdict='correct',met=2,errors=[])=>({target_id:'U1',accepted:true,problems:[],expected_verdict:verdict,expected_met_units:met,meaning_errors:errors});
async function finish(grader,prepared){let state;for(let n=0;n<12;n++){try{return await grader.finish(prepared,{validationState:state,onCheckpoint:async s=>{state=structuredClone(s);}});}catch(e){if(e.code!=='AI_REPAIR_PENDING')throw e;}}throw Error('Fixture did not complete');}

test('Configured Listening model pins match both semantic audit and review; default remains 3.5',async()=>{
 const calls=[];const provider=async({model,prompt})=>{calls.push(model);return prompt.includes('lượt kiểm nội dung độc lập')?{reviews:[review()]}:{results:[row('U1','variant')]};};
 const g=createListeningHomeworkApp({db:{},lesson,identity:{},origins:[],model:'gemini-3.8-flash',provider}).grader;
 const old=createListeningHomeworkApp({db:{},lesson,identity:{},origins:[],provider}).grader;
 const result=await finish(g,g.prepareWeb({...answers(),U1:'variant'}));
 assert.equal(result.pins.model,'gemini-3.8-flash');assert.deepEqual(calls,['gemini-3.8-flash','gemini-3.8-flash']);
 assert.equal(old.pins.model,'gemini-3.5-flash');assert.notEqual(g.pins.sha256,old.pins.sha256);
 assert.equal(result.feedback.U1.status,'correct');
});
test('Gate counts completion separately from accuracy, derived from lesson size',()=>{const g=createListeningGrader({lesson});assert.equal(g.inspectWeb({U1:'x',U2:'x'}).completeness.eligible_for_grading,false);assert.equal(g.inspectWeb({U1:'wrong',U2:'wrong',U3:'wrong'}).completeness.eligible_for_grading,true);assert.throws(()=>g.inspectWeb({foreign:'x'}),/TARGET_UNKNOWN/);});
test('Only whole approved answer bypasses semantics; a longer unknown variant is audited and reviewed',async()=>{let calls=0;const g=createListeningGrader({lesson,provider:async()=>++calls===1?{results:[row('U1','a fresh paraphrase')]}:{reviews:[review()]}});const result=await finish(g,g.prepareWeb({...answers(),U1:'a fresh paraphrase'}));assert.equal(calls,2);assert.equal(result.feedback.U1.status,'correct');assert.equal(result.grading.summary.correctCount,3);});
test('Evidence never manufactured: invalid span repairs, review rejection repairs only affected target',async()=>{let calls=0;const g=createListeningGrader({lesson,provider:async()=>{calls++;if(calls===1)return {results:[row('U1','not in student response')]};if(calls===2||calls===4)return {results:[row('U1','variant',['present','absent'])]};return {reviews:[{...review('partial',1),accepted:calls>3,problems:calls>3?[]:['Hướng sửa cần gắn với ý thứ hai còn thiếu.']}]};}});const result=await finish(g,g.prepareWeb({...answers(),U1:'variant'}));assert.equal(calls,5);assert.equal(result.feedback.U1.status,'partial');assert.equal(result.feedback.U1.metUnits,1);});
test('Writing notes preserve met meaning, contradictions do not become correct',async()=>{const g=createListeningGrader({lesson,provider:async({prompt})=>prompt.includes('lượt kiểm nội dung độc lập')?{reviews:[review()]}:{results:[{...row('U1','typo'),writing_notes:['Sửa lại cách viết.']}]} });assert.equal((await finish(g,g.prepareWeb({...answers(),U1:'typo'}))).feedback.U1.status,'correct');const errors=row('U1','not correct',['present','contradicted']).meaning_errors;const other=createListeningGrader({lesson,provider:async({prompt})=>prompt.includes('lượt kiểm nội dung độc lập')?{reviews:[review('incorrect',1,errors)]}:{results:[row('U1','not correct',['present','contradicted'])]}});assert.equal((await finish(other,other.prepareWeb({...answers(),U1:'not correct'}))).feedback.U1.status,'incorrect');});
test('Wrong or duplicate target identity is never accepted as a complete result',async()=>{const g=createListeningGrader({lesson,provider:async()=>({results:[row('OTHER','x')]})});let state;await assert.rejects(g.finish(g.prepareWeb({...answers(),U1:'x'}),{onCheckpoint:async s=>{state=s;}}),e=>e.code==='AI_REPAIR_PENDING');assert.equal(state.phase,'audit');assert.equal(state.rows.U1,undefined);assert.equal(listeningSummary({grading:{expectedIds:ids,target_results:[{target_id:'U1',verdict:'correct'}]}}),null);});
test('Unknown provider outcome stops for investigation instead of silently re-calling',async()=>{const statuses=[];const g=createListeningGrader({lesson,provider:async()=>{throw Error('network lost');}});await assert.rejects(g.finish(g.prepareWeb({...answers(),U1:'variant'}),{onRound:async e=>statuses.push(e.status)}),e=>e.code==='AI_OUTCOME_UNKNOWN');assert.deepEqual(statuses,['calling','unknown']);});
async function setup(t,audioOverride){const db=new PGlite();await db.exec(await fs.readFile(new URL('../ops/listening-homework67/schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222';const snapshot={classes:[{erp_course_class_id:'1293',erp_class_name_snapshot:'IC-FIXTURE'}],students:[a,b].map((id,i)=>({public_id:id,erp_course_class_id:'1293',erp_student_contact_id:String(i+1),erp_student_name_snapshot:'Fixture '+(i+1),status:'approved'})),memberships:[1,2].map(id=>({erp_course_class_id:'1293',erp_student_contact_id:String(id),source_state:'active'}))};let permitted=true;const context={snapshot:async()=>snapshot,classes:async()=>[{id:'1293',classCode:'IC-FIXTURE'}],roster:async()=>snapshot.students.map(s=>({studentRef:s.public_id,name:s.erp_student_name_snapshot})),teacher:async()=>permitted};const identity=createReading67WebIdentity({db,context,allowedClassIds:['1293'],cookieName:'listening_homework_teacher',cookiePath:'/api/listening-homework67',verifyGoogle:async()=>({email:'teacher@example.test',sub:'fixture',email_verified:true})});const runtime=createListeningHomeworkApp({db,lesson,identity,origins:['https://fixture.test'],studentsOpen:true,audio:audioOverride||{id:lesson.audioId},provider:async()=>{throw Error('No AI expected in this fixture');}});return {...runtime,db,a,b,identity,revoke:()=>{permitted=false;}};}
const prefix='/api/listening-homework67';

test('Listening references require the exact job, rubric, field and occurrence',()=>{
 const item={id:'U1',response:'both\twork. both  work.'};
 const source=listeningEvidenceSource(item,'job-1','lesson-v1');
 const ref=`${source.scope}:4-6`;
 assert.equal(materializeListeningSpans(row('U1',ref),source,'audit').units[0].span,'both  work.');
 for(const other of [
  listeningEvidenceSource({...item,id:'U2'},'job-1','lesson-v1'),
  listeningEvidenceSource(item,'job-2','lesson-v1'),
  listeningEvidenceSource(item,'job-1','lesson-v2'),
  listeningEvidenceSource({...item,response:'both\twork. both work.'},'job-1','lesson-v1'),
 ])assert.throws(()=>materializeListeningSpans(row('U1',ref),other,'audit'),{code:'SOURCE_VERSION_MISMATCH'});
 for(const [wrong,code] of [[null,'SOURCE_REF_MISSING'],['both  work.','SOURCE_REF_INVALID'],[`${source.scope}:6-4`,'SOURCE_REF_INVALID'],[`${source.scope}:1-7`,'SOURCE_REF_INVALID']]){
  assert.throws(()=>materializeListeningSpans(row('U1',wrong),source,'audit'),{code});
 }
});

test('Listening HTTP/SQL pins the job, repairs audit and review, and reads the exact saved text after flag off',async t=>{
 const x=await setup(t);
 const raw='The first speaker agrees,\r\n\tbut B agrees too.';
 let audits=0,reviews=0;
 const provider=async({prompt})=>{
  const {targets:[target]}=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));
  const {scope,marks}=target.source_positions;
  const ref=`${scope}:1-${marks.length}`;
  if(prompt.includes('lượt kiểm nội dung độc lập')){
   assert.equal(target.candidate.units[0].span,raw);
   assert.equal(target.candidate.meaning_errors[0].span,raw);
   const selected=++reviews===1?raw:ref;
   return {reviews:[review('incorrect',1,row('U1',selected,['present','contradicted']).meaning_errors)]};
  }
  const selected=++audits===1?'The first speaker agrees, but B agrees too.':ref;
  return {results:[row('U1',selected,['present','contradicted'])]};
 };
 const runtime=referenceJobs=>createListeningHomeworkApp({db:x.db,lesson,identity:x.identity,origins:[],studentsOpen:true,provider,referenceJobs});
 const enabled=runtime(true),api=request(enabled.app);
 const owner=await x.identity.loginStudent({classId:'1293',studentRef:x.a});
 const auth='Bearer '+owner.token;
 const draft=await api.put(prefix+'/draft').set('Authorization',auth).send({baseRevision:0,mutationId:randomUUID(),
  body:{answers:{...answers(),U1:raw},annotations:[],notes:'',flags:[]}}).expect(200);
 const submission={revision:draft.body.revision,requestId:randomUUID()};
 const sent=await api.post(prefix+'/submit').set('Authorization',auth).send(submission).expect(202);
 const jobId=sent.body.jobId;
 const read=async()=> (await x.db.query('SELECT state FROM reading_listening67.web_validation WHERE job_id=$1',[jobId])).rows[0].state;
 assert.equal((await read()).version,LISTENING_SOURCE_VERSION);
 const disabled=runtime(false);
 const resetDelay=()=>x.db.query('UPDATE reading_listening67.web_validation SET next_attempt_at=now() WHERE job_id=$1',[jobId]);
 await disabled.worker.tick();
 const initial=await read();
 assert.equal(initial.issues[0].code,'SOURCE_REF_INVALID');
 assert.equal(initial.rows.U1,undefined);
 await resetDelay();
 await disabled.worker.tick();
 await resetDelay();
 await disabled.worker.tick();
 const rejectedReview=await read();
 assert.equal(rejectedReview.phase,'review');
 assert.equal(rejectedReview.issues[0].code,'SOURCE_REF_INVALID');
 assert.equal(rejectedReview.approved.U1,undefined);
 await resetDelay();
 const interrupted=await disabled.store.claim();
 const prepared=disabled.grader.prepareWeb(interrupted.answers,interrupted.jobId);
 await assert.rejects(disabled.grader.finish(prepared,{validationState:rejectedReview,onRound:async event=>{
  await disabled.store.validation.round(interrupted,event);
  if(event.status==='received')throw Error('FIXTURE_LOST_WORKER_AFTER_RESPONSE');
 }}),/FIXTURE_LOST_WORKER_AFTER_RESPONSE/);
 await x.db.query("UPDATE reading_listening67.web_job SET status='queued',lease_until=NULL,lease_token=NULL WHERE id=$1",[jobId]);
 await disabled.worker.tick();
 const result=await api.get(prefix+'/attempts/'+sent.body.attemptId).set('Authorization',auth).expect(200);
 assert.equal(result.body.status,'done');
 assert.equal(result.body.snapshot.answers.U1,raw);
 const stored=result.body.result.grading.target_results.find(target=>target.target_id==='U1');
 assert.equal(stored.verdict,'incorrect');
 assert.equal(stored.metUnits,1);
 assert.equal(stored.units[0].span,raw);
 assert.equal(stored.meaning_errors[0].span,raw);
 const audited=await read();
 assert.equal(audited.sourceAudit[0].reviewMeaningErrors[0].span,raw);
 assert.equal(audited.sourceAuditHash,result.body.result.grading.validation.sourceAuditHash);
 const received=await x.db.query('SELECT response,status FROM reading_listening67.web_validation_round WHERE job_id=$1 ORDER BY round_no',[jobId]);
 assert.equal(received.rows.length,4);
 assert.ok(received.rows.every(round=>round.status==='applied'));
 assert.match(received.rows[3].response.reviews[0].meaning_errors[0].span,/^[a-f0-9]{32}:1-/u);
 assert.deepEqual([audits,reviews],[2,2]);
 const other=await x.identity.loginStudent({classId:'1293',studentRef:x.b});
 await api.get(prefix+'/attempts/'+sent.body.attemptId).set('Authorization','Bearer '+other.token).expect(404);
 const replay=await api.post(prefix+'/submit').set('Authorization',auth).send(submission);
 assert.equal(replay.body.attemptId,sent.body.attemptId);
});

test('R2 descriptor is issued only after native Homework identity and teacher class authorization',async t=>{
 const catalog=JSON.parse(await fs.readFile(new URL('../src/listening-homework67/r2-audio-catalog.json',import.meta.url),'utf8')),asset=Object.values(catalog)[0];
 const file=tmpdir()+'/listening-r2-'+randomUUID()+'.json',prior={enabled:process.env.AUDIO_R2_DIRECT_ENABLED,file:process.env.AUDIO_R2_DIRECT_CONFIG_FILE};
 await fs.writeFile(file,JSON.stringify({enabled:true,assets:[asset.sha256],accountId:'e340869dcc6ff285504947407d148104',bucket:'izone-audio-r2-lab-20261023',accessKeyId:'fixture-key',secretAccessKey:'fixture-secret'}));
 process.env.AUDIO_R2_DIRECT_ENABLED='true';process.env.AUDIO_R2_DIRECT_CONFIG_FILE=file;
 t.after(async()=>{for(const [key,value] of [['AUDIO_R2_DIRECT_ENABLED',prior.enabled],['AUDIO_R2_DIRECT_CONFIG_FILE',prior.file]])if(value===undefined)delete process.env[key];else process.env[key]=value;await fs.unlink(file);});
 const x=await setup(t,{...asset,id:lesson.audioId}),api=request(x.app),h={'X-Izone-Audio-Transport':'r2-direct-v1'};
 assert.equal((await api.get(prefix+'/audio').set(h)).status,401);
 const student=await x.identity.loginStudent({classId:'1293',studentRef:x.a});
 const old=await api.get(prefix+'/audio').set('Authorization','Bearer '+student.token);assert.equal(old.status,200);assert.equal(old.body.audioDownload,undefined);
 const valid=await api.get(prefix+'/audio').set(h).set('Authorization','Bearer '+student.token);assert.equal(valid.status,200);assert.equal(valid.body.audioDownload.sha256,asset.sha256);assert.equal(valid.body.audioDownload.policy,'r2-direct-v1');assert.match(valid.headers['cache-control'],/no-store/);
 assert.equal((await api.get(prefix+'/audio').set(h).set('Authorization','Bearer invalid')).status,401);
 const teacher=request.agent(x.app);await teacher.post(prefix+'/teacher/login').send({credential:'fixture-allowed-token'}).expect(200);
 assert.equal((await teacher.get(prefix+'/audio?teacher=1&classId=1293').set(h)).status,200);
 x.revoke();assert.equal((await teacher.get(prefix+'/audio?teacher=1&classId=1293').set(h)).status,403);
});
test('HTTP/SQL: independent owners, CAS/retry, immutable attempts, worker completion, history, reset',async t=>{const x=await setup(t),api=request(x.app);const login=await x.identity.loginStudent({classId:'1293',studentRef:x.a}),auth='Bearer '+login.token;const payload={baseRevision:0,mutationId:randomUUID(),body:{answers:answers(),annotations:[],notes:'Private note',flags:[3]}};const ack=await api.put(prefix+'/draft').set('Authorization',auth).send(payload).expect(200);await api.put(prefix+'/draft').set('Authorization',auth).send(payload).expect(200);const submit={revision:ack.body.revision,requestId:randomUUID()};const submitted=await api.post(prefix+'/submit').set('Authorization',auth).send(submit).expect(202);const again=await api.post(prefix+'/submit').set('Authorization',auth).send(submit).expect(202);assert.equal(submitted.body.attemptId,again.body.attemptId);await api.put(prefix+'/draft').set('Authorization',auth).send({...payload,mutationId:randomUUID(),baseRevision:1,body:{...payload.body,notes:'New draft after submit'}}).expect(200);await x.worker.tick();const result=await api.get(prefix+'/attempts/'+submitted.body.attemptId).set('Authorization',auth).expect(200);assert.equal(result.body.status,'done');assert.equal(result.body.progress.total,3);assert.equal(result.body.snapshot.notes,'Private note');const other=await x.identity.loginStudent({classId:'1293',studentRef:x.b});await api.get(prefix+'/attempts/'+submitted.body.attemptId).set('Authorization','Bearer '+other.token).expect(404);await api.put(prefix+'/draft').set('Authorization',auth).send({...payload,mutationId:randomUUID()}).expect(409);const reset=await api.post(prefix+'/reset').set('Authorization',auth).send({baseRevision:2,mutationId:randomUUID()}).expect(200);assert.equal(reset.body.runNo,2);const history=await api.get(prefix+'/attempts').set('Authorization',auth);assert.equal(history.body.attempts.length,1);assert.equal(history.body.archives[0].body.notes,'New draft after submit');});
test('No key in public lesson; teacher cookie cannot submit; wrong class and revoked teacher denied',async t=>{const x=await setup(t),api=request(x.app);await api.get(prefix+'/audio').expect(401);const student=await x.identity.loginStudent({classId:'1293',studentRef:x.a});const content=await api.get(prefix+'/lesson').set('Authorization','Bearer '+student.token).expect(200);assert.equal(JSON.stringify(content.body).includes('approved U1'),false);const agent=request.agent(x.app);await agent.post(prefix+'/teacher/login').send({credential:'fixture-allowed-token'}).expect(200);await agent.get(prefix+'/teacher/work/1293/'+x.a).expect(200);await agent.post(prefix+'/submit').send({revision:1,requestId:randomUUID()}).expect(401);await agent.get(prefix+'/teacher/work/999/'+x.a).expect(403);x.revoke();await agent.get(prefix+'/teacher/work/1293/'+x.a).expect(403);});
test('Listening Docs planner touches only Listening cell and preserves Reading/manual text',()=>{const p=(start,text)=>({paragraph:{elements:[{startIndex:start,textRun:{content:text+'\n'}}]}}),doc={documentId:'fixture',revisionId:'revision',tabs:[{tabProperties:{tabId:'t'},documentTab:{body:{content:[{table:{tableRows:[{tableCells:[{content:[p(10,DOC_CONTRACT.cta),p(100,lesson.code)]},{content:[p(200,'Reading CTA')]}]},{tableCells:[{content:[p(300,DOC_CONTRACT.status)]},{content:[p(400,'TÌNH TRẠNG NỘP BÀI READING')]}]},{tableCells:[{content:[p(500,'Listening handwritten')]},{content:[p(600,'Reading handwritten')]}]}]}}]}}}]};const binding={document_id:'fixture',tab_id:'t',code:lesson.code,last_doc_text:''};assert.equal(locateReading67Homework(doc,binding,DOC_CONTRACT).cta.start,10);const plan=planReading67HomeworkWrite(doc,binding,{kind:'status',payload:{text:'Đã nộp bài, đang chờ chấm.'}},DOC_CONTRACT);assert.equal(plan.requests[0].insertText.location.index,500+'Listening handwritten'.length);assert.equal(plan.requests[0].insertText.text,'\n'+DOC_CONTRACT.prefix+'Đã nộp bài, đang chờ chấm.');assert.ok(!plan.requests.some(r=>r.deleteContentRange));});

test('Exhausted validation keeps a review hold; learner cannot create another identical AI job',async t=>{const x=await setup(t),scope={ownerId:x.a,courseId:'1293',code:lesson.code,version:lesson.version};const saved=await x.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body:{answers:answers(),annotations:[],notes:'',flags:[]}});const sent=await x.store.submit(scope,{revision:saved.revision,requestId:randomUUID()});const job=await x.store.claim();await x.store.fail(job,{code:'AI_VALIDATION_NEEDS_REVIEW'});assert.equal((await x.store.attempt(scope,sent.attemptId)).status,'needs_review');await assert.rejects(x.store.submit(scope,{revision:saved.revision,requestId:randomUUID()}),e=>e.code==='PREVIOUS_GRADING_NEEDS_REVIEW');assert.equal((await x.store.history(scope)).length,1);});
test('Completed AI feedback is distinct from mastery in Homework Docs text',()=>{assert.equal(listeningCompletionText({runNo:1,progress:{allCorrect:false}}),'Đã có góp ý cho lượt luyện 1.');assert.equal(listeningCompletionText({runNo:2,progress:{allCorrect:true}}),'Đã đạt toàn bộ mục ở lượt luyện 2.');});
test('Live authority fields support new class IDs but only the pinned ongoing K67 scope; stale/hash/duplicate data reject',async()=>{const payload={apiVersion:1,productId:'PRODUCT-TERM-MINI-K67',classes:[{erp_course_class_id:'1307',erp_class_name_snapshot:'FixtureNew',erp_course_id:'5'},{erp_course_class_id:'1000',erp_class_name_snapshot:'FixtureOld',erp_course_id:'5'},{erp_course_class_id:'9000',erp_class_name_snapshot:'FixtureOther',erp_course_id:'6'}],students:[],memberships:[],accounts:[],access:[]};const now=Date.now(),envelope=()=>({...payload,capturedAt:new Date(now).toISOString(),sourceRevision:sha256(JSON.stringify(payload))});let raw=envelope();const make=()=>createListeningContext({url:'http://fixture',key:'fixture',allowedClassIds:['1307','9000'],clock:()=>now,fetcher:async()=>Response.json(raw)});assert.deepEqual(await make().classes(),[{id:'1307',classCode:'FixtureNew'}]);raw={...envelope(),capturedAt:new Date(now-121000).toISOString()};await assert.rejects(make().snapshot(),e=>e.code==='CONTEXT_UNAVAILABLE');raw={...envelope(),sourceRevision:'0'.repeat(64)};await assert.rejects(make().snapshot(),e=>e.code==='CONTEXT_UNAVAILABLE');});
