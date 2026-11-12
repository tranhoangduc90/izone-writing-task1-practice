// Kiểm SQL/HTTP thật với hai identity giả; không gọi Google, AI hoặc production.
// Parser/gate lấy từ snapshot live riêng của lần kiểm; chấm giả chỉ dùng kiểm lease.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import {loadReading67WebGrader,sha256,reading67AnswerFingerprint,WebGradingError} from '../src/reading-listening67/web-grader.js';
import {createReading67WebStore,createReading67WebWorker} from '../src/reading-listening67/web-store.js';
import {createReading67WebRouter} from '../src/reading-listening67/web-routes.js';
import {SOURCE_VALIDATION_VERSION, VALIDATION_VERSION} from '../src/reading-listening67/web-validation.js';
import {createReading67Homework} from '../src/reading-listening67/web-homework.js';
import {memoryDocs} from '../test-support/reading67-memory-docs.js';

const fixtureDir=process.env.READING67_TEST_FIXTURE_DIR;
const integration=test.skip;
const run=fixtureDir?test:integration;
let grader;
if(fixtureDir){const snapshotPath=path.join(fixtureDir,'live-grader.private.json');grader=await loadReading67WebGrader({snapshotPath,expectedSha256:sha256(await fs.readFile(snapshotPath,'utf8'))});}
const a={ownerId:'11111111-1111-4111-8111-111111111111',courseId:'course_A',code:'67-reading-materials-beyond-concrete-matching-information-nen-cap-1',version:'fixture-v1'};
const b={...a,ownerId:'22222222-2222-4222-8222-222222222222'};
const body=(n=20,tag='A')=>({answers:Object.fromEntries(grader.profile.expected_target_ids.slice(0,n).map((id,i)=>[id,id.endsWith('.section')?'B':`Bài giả ${tag} số ${i}: giữ ý chính.`])),annotations:[],notes:'',flags:[]});
async function setup(t,dir){const db=new PGlite(dir);await db.exec(await fs.readFile(new URL('../../docs/migrations/2026-10-22-reading67-web.sql',import.meta.url),'utf8'));t.after(()=>db.close());return {db,store:createReading67WebStore({db,grader})};}
const save=(store,scope,value,revision=0,mutationId=randomUUID())=>store.save(scope,{body:value,baseRevision:revision,mutationId});
const submit=(store,scope,revision,requestId=randomUUID())=>store.submit(scope,{revision,requestId});
function resultFor(job){const ids=grader.profile.expected_target_ids;return {pins:grader.pins,context:{operationId:job.jobId,sourceDigest:job.inputHash},grading:{target_results:ids.map(target_id=>({target_id,verdict:'correct'})),summary:{correct:20}},feedback:Object.fromEntries(ids.map(id=>[id,{status:'correct'}])),providerResponse:{fixture:true}};}

run('Nháp SQL tách người/lớp/version; CAS và retry giữ đúng bài',async t=>{
 const {store}=await setup(t);const id=randomUUID(),value=body(16);
 const first=await save(store,a,value,0,id);assert.equal(first.revision,1);assert.equal(first.completeness.filled_cells,16);
 assert.equal((await store.draft(b)).revision,0);
 assert.equal((await store.draft({...a,courseId:'other'})).revision,0);
 assert.equal((await store.draft({...a,version:'v2'})).revision,0);
 assert.equal((await save(store,a,value,0,id)).revision,1);
 await assert.rejects(save(store,a,body(20),0,id),{code:'MUTATION_ID_REUSED'});
 await assert.rejects(save(store,a,body(20),0),{code:'DRAFT_REVISION_CONFLICT'});
 assert.deepEqual((await store.draft(a)).body,value);
 const unicode=body(16);unicode.notes='Tiếng Việt → giữ dấu và xuống dòng\nDòng thứ hai.';unicode.annotations=[{id:'note-1',quote:'concrete',note:'Xi măng khác bê tông'}];
 assert.equal((await save(store,a,unicode,1)).revision,2);assert.deepEqual((await store.draft(a)).body,unicode);
});
run('Ngưỡng live 15/20 không tạo job; 16/20 và request lặp chỉ một lượt',async t=>{
 const {store,db}=await setup(t);await save(store,a,body(15));
 await assert.rejects(submit(store,a,1),{code:'BELOW_COMPLETION_THRESHOLD'});
 assert.equal((await db.query('SELECT count(*)::int n FROM reading_listening67.web_job')).rows[0].n,0);
 await save(store,a,body(16),1);const id=randomUUID(),one=await submit(store,a,2,id);
 const two=await submit(store,a,2,id);assert.equal(one.attemptId,two.attemptId);
 assert.equal((await submit(store,a,2)).attemptId,one.attemptId);
 assert.equal((await db.query('SELECT count(*)::int n FROM reading_listening67.web_job')).rows[0].n,1);
 await assert.rejects(submit(store,a,1,id),{code:'REQUEST_ID_REUSED'});
 await assert.rejects(store.attempt(b,one.attemptId),{code:'ATTEMPT_NOT_FOUND'});
 assert.equal((await store.history(b)).length,0);
});
run('Bản gửi bất biến khi sửa nháp; kết quả cũ không phủ nháp mới',async t=>{
 const {store}=await setup(t);const initial=body(20,'trước');await save(store,a,initial);const sent=await submit(store,a,1);const job=await store.claim();
 const revised=body(20,'sau');await save(store,a,revised,1);await store.finish(job,resultFor(job));
 const old=await store.attempt(a,sent.attemptId);assert.deepEqual(old.snapshot,initial);assert.equal(old.status,'done');
 assert.deepEqual((await store.draft(a)).body,revised);assert.equal((await store.draft(a)).revision,2);
 const after=await submit(store,a,2);assert.notEqual(after.attemptId,sent.attemptId);
 assert.equal((await store.history(a)).length,2);
});
run('Hai người xen kẽ, callback đảo thứ tự và lease sai không ghi nhầm',async t=>{
 const {store}=await setup(t);await save(store,a,body(20,'A'));await save(store,b,body(20,'B'));const sa=await submit(store,a,1),sb=await submit(store,b,1);
 const ja=await store.claim(),jb=await store.claim();assert.notEqual(ja.attemptId,jb.attemptId);
 await assert.rejects(store.finish({...ja,leaseToken:randomUUID()},resultFor(ja)),{code:'JOB_LEASE_NOT_OWNED'});
 await assert.rejects(store.finish({...ja,ownerId:b.ownerId},resultFor(ja)),{code:'JOB_LEASE_NOT_OWNED'});
 await assert.rejects(store.finish(ja,resultFor(jb)),{code:'RESULT_IDENTITY_MISMATCH'});
 await store.finish(jb,resultFor(jb));await store.finish(ja,resultFor(ja));
 assert.equal((await store.attempt(a,sa.attemptId)).status,'done');assert.equal((await store.attempt(b,sb.attemptId)).status,'done');
 await assert.rejects(store.finish(ja,resultFor(ja)),{code:'JOB_LEASE_NOT_OWNED'});
});
run('Fail-closed khi thiếu/trùng target hoặc sai bản bộ chấm',async t=>{
 const {store}=await setup(t);await save(store,a,body());await submit(store,a,1);const job=await store.claim();
 for(const variant of [r=>{r.grading.target_results.pop();},r=>{r.grading.target_results[1]=r.grading.target_results[0];},r=>{r.pins={...r.pins,sha256:'bad'};},r=>{r.context.sourceDigest='bad';}]){const r=resultFor(job);variant(r);await assert.rejects(store.finish(job,r),{code:'RESULT_IDENTITY_MISMATCH'});}
 await store.fail(job,new WebGradingError('AI_OUTCOME_UNKNOWN',503));assert.equal((await store.history(a))[0].status,'needs_review');
 await assert.rejects(submit(store,a,1),{code:'PREVIOUS_GRADING_NEEDS_REVIEW'});
});
run('HTTP giữ quyền; không nhận owner hoặc field giả từ học viên',async t=>{
 const {store}=await setup(t);const content={code:a.code,version:a.version,title:'Bài giả, không có key'};
 const app=express();app.use('/api',createReading67WebRouter({store,content,grader,authenticate:q=>q.headers['x-fixture-owner']==='A'?a:q.headers['x-fixture-owner']==='B'?b:null}));
 await request(app).get('/api/draft').expect(401);
 const input={baseRevision:0,mutationId:randomUUID(),body:body()};
 await request(app).put('/api/draft').set('x-fixture-owner','A').send({...input,ownerId:b.ownerId}).expect(400);
 await request(app).put('/api/draft').set('x-fixture-owner','A').send(input).expect(200);
 const sent=await request(app).post('/api/submit').set('x-fixture-owner','A').send({revision:1,requestId:randomUUID()}).expect(202);
 await request(app).get('/api/attempts/'+sent.body.attemptId).set('x-fixture-owner','B').expect(404);
 const waiting=await request(app).get('/api/attempts/'+sent.body.attemptId).set('x-fixture-owner','A').expect(200);assert.equal(waiting.body.result,null);
 await request(app).put('/api/draft').set('x-fixture-owner','A').send({...input,baseRevision:1,mutationId:randomUUID(),body:{...body(),answers:{unknown:'x'}}}).expect(422);
});
run('Đĩa máy chủ giữ nháp và kết quả sau mở lại database',async t=>{
 const base=process.env.READING67_TEST_DATA_DIR||os.tmpdir();await fs.mkdir(base,{recursive:true});const dir=await fs.mkdtemp(path.join(base,'rl67-web-'));
 const db=new PGlite(dir);await db.exec(await fs.readFile(new URL('../../docs/migrations/2026-10-22-reading67-web.sql',import.meta.url),'utf8'));const store=createReading67WebStore({db,grader});
 await save(store,a,body(20));const sent=await submit(store,a,1),job=await store.claim();await store.finish(job,resultFor(job));await db.close();
 const reopened=new PGlite(dir);t.after(()=>reopened.close());const after=createReading67WebStore({db:reopened,grader});assert.equal((await after.draft(a)).revision,1);assert.equal((await after.attempt(a,sent.attemptId)).status,'done');
});
run('Worker không chấm đôi khi tick chồng, lỗi AI không tạo feedback thành công',async t=>{
 const {store}=await setup(t);await save(store,a,body());const sent=await submit(store,a,1);let calls=0,release;
 const pending=new Promise(resolve=>release=resolve);
 const worker=createReading67WebWorker({store,grader:{...grader,finish:async prepared=>{calls++;await pending;throw new WebGradingError('AI_SCHEMA_INVALID',503);}}});
 const first=worker.tick();while(!calls)await new Promise(r=>setTimeout(r,5));await worker.tick();assert.equal(calls,1);release();await first;
 const result=await store.attempt(a,sent.attemptId);assert.equal(result.status,'failed');assert.equal(result.result,null);await worker.close();
});

run('Materials persists source text after reference repair and returns the result to the original owner', async t => {
  const snapshotPath = path.join(fixtureDir, 'live-grader.private.json');
  const prompts = [], responses = [], workerErrors = [];
  const graderOptions = {
    snapshotPath, expectedSha256: sha256(await fs.readFile(snapshotPath, 'utf8')), validation: true,
    provider: async prompt => {
      prompts.push(prompt.prompt);
      const payload = responses.shift()?.(prompt.prompt);
      assert.ok(payload);
      return {
        gatewayMeta: {model_id:sourceGrader.pins.model,thinking_level:sourceGrader.pins.thinking,worker:'fixture',dispatcher_worker:'fixture'},
        candidates: [{finishReason:'STOP',content:{parts:[{text:JSON.stringify(payload)}]}}],
      };
    },
  };
  const sourceGrader = await loadReading67WebGrader({...graderOptions,referenceJobs:true});
  const input = body();
  const targetId = sourceGrader.prepareWeb(input.answers).graded.semantic_targets[0].target_id;
  const original = 'Từ A,\r\n\tđến B. Từ A, đến B.';
  input.answers[targetId] = original;
  const prepared = sourceGrader.prepareWeb(input.answers);
  const targets = prepared.graded.semantic_targets;
  const p = prepared.graded.stability_decision_profile;
  let correctedUnitAudit, legacyPayload;
  const reviewed=()=>({results:targets.map(({target_id})=>({target_id,accepted:true,scope:'feedback',fields:[],problems:[]}))});
  responses.push(prompt => {
    const positions = JSON.parse(prompt.match(/<SOURCE_POSITIONS>(.*?)<\/SOURCE_POSITIONS>$/s)[1]);
    const results = targets.map(({target_id}) => {
      const rubric = p.structured_oracles[target_id];
      const {scope, marks} = positions[target_id];
      return {
        target_id,
        unit_audit: [...rubric.core_units,...rubric.secondary_required_units,...rubric.optional_units].map(unit=>({
          unit_id:unit.id,status:'present',student_span:`${scope}:1-${target_id===targetId?6:marks.length}`,
        })),
        relation_status:rubric.required_relation.applicable?'correct':'not_applicable',
        economy_status:rubric.economy_applicable?'adequate':'not_applicable',
        critical_failure:null,primary_issue_unit_id:null,proposed_error_code:null,why_student_wrong:'',
      };
    });
    const altered = results.find(row=>row.target_id===targetId);
    correctedUnitAudit = structuredClone(altered.unit_audit);
    altered.unit_audit[0].student_span = 'từ A đến B';
    const payload={schema_version:p.ai_schema_version,lesson_id:p.lesson_id,prompt_version:p.prompt_version,oracle_version:p.oracle_version,results};
    legacyPayload=structuredClone(payload);
    for(const row of legacyPayload.results){
      const text=targets.find(target=>target.target_id===row.target_id).student_response;
      for(const unit of row.unit_audit)unit.student_span=text;
    }
    return payload;
  }, () => ({
    results:[{target_id:targetId,unit_audit:correctedUnitAudit}],
  }), reviewed);

  const db = new PGlite();
  t.after(()=>db.close());
  for(const migration of ['2026-10-22-reading67-web.sql','2026-10-22-reading67-identity.sql','2026-10-22-reading67-homework.sql','2026-10-26-reading67-validation.sql']){
    await db.exec(await fs.readFile(new URL('../../docs/migrations/'+migration,import.meta.url),'utf8'));
  }
  const docs=memoryDocs(a.code), documentId='doc-'+a.ownerId;
  const owner={
    resolve:async scope=>({classId:scope.courseId,studentRef:scope.ownerId,code:scope.code,version:scope.version,
      courseId:'classroom',courseWorkId:'work78',submissionId:'sub-'+scope.ownerId,documentId:'doc-'+scope.ownerId,tabId:'child'}),
    verify:async target=>target,
  };
  const homework=createReading67Homework({db,docs,owner,metadata:{code:a.code,version:a.version,homeworkLesson:78},pageBase:'https://page.test/reading-skills67/'});
  const store=createReading67WebStore({db,grader:sourceGrader,homework});
  const worker=createReading67WebWorker({store,grader:sourceGrader,onError:error=>workerErrors.push(error)});
  t.after(()=>worker.close());
  await save(store,a,input);
  const requestId=randomUUID(), sent=await submit(store,a,1,requestId);
  const readState=async()=> (await db.query('SELECT state FROM reading_listening67.web_validation WHERE job_id=$1',[sent.jobId])).rows[0]?.state;
  assert.equal((await readState()).version,SOURCE_VALIDATION_VERSION);
  await worker.tick();
  assert.deepEqual(workerErrors.map(error=>error.code),[]);
  const pending=await readState();
  assert.deepEqual(pending.issues.map(({code,targetId})=>[code,targetId]),[['SOURCE_REF_INVALID',targetId]]);
  assert.equal((await store.attempt(a,sent.attemptId)).result,null);
  // Turning off new reference jobs leaves the already-pinned job on the same contract.
  await worker.close();
  const legacyGrader=await loadReading67WebGrader({...graderOptions,referenceJobs:false});
  const legacyStore=createReading67WebStore({db,grader:legacyGrader,homework});
  const rollbackWorker=createReading67WebWorker({store:legacyStore,grader:legacyGrader,onError:error=>workerErrors.push(error)});
  t.after(()=>rollbackWorker.close());
  await db.query("UPDATE reading_listening67.web_validation SET next_attempt_at=now() WHERE job_id=$1",[sent.jobId]);
  await rollbackWorker.tick();
  const repaired=await readState();
  assert.equal(repaired.phase,'review',JSON.stringify({issues:repaired.issues,lastRepairError:repaired.lastRepairError}));
  await db.query("UPDATE reading_listening67.web_validation SET next_attempt_at=now() WHERE job_id=$1",[sent.jobId]);
  await rollbackWorker.tick();
  assert.deepEqual(workerErrors.map(error=>error.code),[]);
  const state=await readState();
  assert.equal(state.phase,'complete');
  assert.equal(state.sourceAudit.find(row=>row.target_id===targetId).unit_audit[0].student_span,'Từ A,\r\n\tđến B.');
  assert.equal(prompts.length,3);
  assert.match(prompts[1],/SOURCE_REF_INVALID/);
  assert.match(prompts[2],/Từ A,\\r\\n\\tđến B\./);
  const app=express();
  app.use('/api',createReading67WebRouter({
    store,grader:sourceGrader,content:{code:a.code,version:a.version,title:'Materials fixture'},
    authenticate:req=>req.headers['x-fixture-owner']==='A'?a:b,
  }));
  const response=await request(app).get('/api/attempts/'+sent.attemptId).set('x-fixture-owner','A').expect(200);
  assert.equal(response.body.status,'done');
  assert.equal(response.body.snapshot.answers[targetId],original);
  assert.equal(response.body.result.grading.validation.version,SOURCE_VALIDATION_VERSION);
  assert.equal(response.body.result.grading.target_results.find(row=>row.target_id===targetId).verdict,'correct');
  await request(app).get('/api/attempts/'+sent.attemptId).set('x-fixture-owner','B').expect(404);
  assert.equal((await submit(store,a,1,requestId)).attemptId,sent.attemptId);
  assert.equal((await db.query('SELECT count(*)::int n FROM reading_listening67.web_result')).rows[0].n,1);
  for(let i=0;i<10;i++)if(!await homework.once())break;
  const docJobs=(await db.query('SELECT status,payload FROM reading_listening67.web_homework_job ORDER BY sequence')).rows;
  const completion=docJobs.at(-1);
  assert.equal(completion.status,'verified');
  const link=new URL(completion.payload.link);
  assert.equal(link.searchParams.get('studentRef'),a.ownerId);
  assert.equal(link.searchParams.get('attemptId'),sent.attemptId);
  const savedDoc=docs.get(documentId).chars;
  assert.match(savedDoc.map(item=>item.text).join(''),/^Chữ tay giữ nguyên\n/);
  assert.equal(savedDoc.filter(item=>item.style.link?.url===link.href).map(item=>item.text).join(''),'nhấn vào đây');

  // Jobs submitted while the switch is off continue using V2.
  await save(legacyStore,b,input);
  const old=await submit(legacyStore,b,1);
  responses.push(()=>legacyPayload,reviewed);
  await rollbackWorker.tick();
  await db.query("UPDATE reading_listening67.web_validation SET next_attempt_at=now() WHERE job_id=$1",[old.jobId]);
  await rollbackWorker.tick();
  const legacyResult=await store.attempt(b,old.attemptId);
  assert.equal(legacyResult.status,'done');
  assert.equal(legacyResult.result.grading.validation.version,VALIDATION_VERSION);
  assert.doesNotMatch(prompts[3],/<SOURCE_POSITIONS>/);
  assert.deepEqual(legacyResult.result.grading.target_results,response.body.result.grading.target_results);
});
