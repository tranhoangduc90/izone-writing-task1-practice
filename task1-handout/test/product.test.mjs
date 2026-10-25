import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {setup,queue,feedback,revision,modelResponse} from './helpers.mjs';
import {createApp} from '../src/app.mjs';
import {processBatch} from '../src/worker.mjs';
import {renderPrompt,validateFeedback,normalizeFeedback,readModel,sha} from '../src/grading.mjs';
import {loadConfig} from '../src/config.mjs';
import fs from 'node:fs/promises';

test('frozen context and one Check survive duplicate request and prompt replacement',async t=>{
 const x=await setup(t),id=randomUUID(),input={sessionRef:x.sessionRef,section:'overview',requestId:id,snapshot:x.snapshot};
 const a=await x.service.submitCheck(input),b=await x.service.submitCheck(input);assert.equal(a.attemptRef,b.attemptRef);
 await assert.rejects(x.service.submitCheck({...input,snapshot:{...x.snapshot,overview:'Khác'}}),e=>e.code==='REQUEST_ID_REUSED');
 await x.pool.query("UPDATE task1_private.prompt SET template='Bản mới' WHERE section='overview'");
 const [job]=await x.service.claimJobs({workerId:'test',maxJobs:2,leaseSeconds:420});
 assert.match(renderPrompt(job.gradingContext),/Nhận xét thử/u);assert.notEqual(job.gradingContext.template,'Bản mới');
 assert.equal((await x.pool.query('SELECT count(*)::int n FROM writing_practice.check_attempt')).rows[0].n,1);
});
test('Draft needs_revision is academic, editable and has no LMS; duplicate delivery is idempotent',async t=>{
 const x=await setup(t);await queue(x,'draft');const result=await processBatch({service:x.service,aiUrl:'https://fixture.invalid',call:async()=>modelResponse(revision)});
 assert.equal(result[0].resultStatus,'needs_revision');const detail=await x.service.sessionDetails(x.sessionRef);
 assert.equal(detail.sections.draft.locked,false);assert.equal(detail.sections.draft.failStreak,1);assert.equal(detail.comments.length,1);assert.equal(detail.comments[0].feedback,revision);
 const receipt=(await x.pool.query('SELECT * FROM task1_private.result_receipt')).rows[0];assert.equal(receipt.response.resultStatus,'needs_revision');
});
test('Draft clean answer locks only after academic pass; stale lease is rejected',async t=>{
 const x=await setup(t);await queue(x,'draft');const [job]=await x.service.claimJobs({workerId:'test',maxJobs:2,leaseSeconds:420});
 const input={jobRef:job.jobRef,leaseToken:job.leaseToken,resultStatus:'passed',feedback:feedback.draft,artifacts:{productId:'sw-task1',attemptRef:job.jobRef,mode:'socratic-v2',promptSha256:job.gradingContext.promptSha256,snapshotSha256:sha(job.snapshot)}};
 await assert.rejects(x.service.completeJob({...input,leaseToken:randomUUID()}),e=>e.code==='LEASE_NOT_OWNED');
 const a=await x.service.completeJob(input),b=await x.service.completeJob(input);assert.deepEqual(a,b);
 await assert.rejects(x.service.completeJob({...input,feedback:feedback.draft+' Khác.'}),e=>e.code==='RESULT_REPLAY_CONFLICT');
 assert.equal((await x.service.sessionDetails(x.sessionRef)).sections.draft.locked,true);
});
test('AI timeout is technical and never raises academic fail streak; retry gets new attempt',async t=>{
 const x=await setup(t),sent=await queue(x);
 const r=await processBatch({service:x.service,aiUrl:'https://fixture.invalid',call:async()=>{throw Error('timeout');}});assert.equal(r[0].outcome,'technical_error');
 const detail=await x.service.sessionDetails(x.sessionRef);assert.equal(detail.sections.overview.failStreak,0);assert.equal(detail.sections.overview.status,'technical_error');
 const next=await x.service.retryAttempt(sent.attemptRef);assert.notEqual(next.attemptRef,sent.attemptRef);
 assert.equal((await x.service.sessionDetails(x.sessionRef)).comments.length,2);
});
test('global capacity survives another worker and expired leases are recovered',async t=>{
 const x=await setup(t);await queue(x,'overview');await queue(x,'outline');
 const first=await x.service.claimJobs({workerId:'a',maxJobs:2,leaseSeconds:420}),second=await x.service.claimJobs({workerId:'b',maxJobs:2,leaseSeconds:420});
 assert.equal(first.length,2);assert.equal(second.length,0);
 await x.pool.query("UPDATE writing_practice.check_attempt SET lease_expires_at=now()-interval '1 second'");await x.service.recoverJobs();
 assert.equal((await x.service.claimJobs({workerId:'b',maxJobs:2,leaseSeconds:420})).length,2);
 await assert.rejects(x.service.claimJobs({workerId:'x',maxJobs:1,leaseSeconds:420,workerPool:'task2'}),e=>e.code==='WRONG_PRODUCT');
});
test('saved Draft and prerequisites are enforced; conflicting saves preserve original',async t=>{
 const x=await setup(t);
 await assert.rejects(x.service.submitCheck({sessionRef:x.sessionRef,section:'draft',requestId:randomUUID(),snapshot:x.snapshot}),e=>e.code==='DRAFT_PREREQUISITES_NOT_PASSED');
 await x.service.saveDraft({sessionRef:x.sessionRef,baseVersion:0,requestId:randomUUID(),...x.snapshot});
 await assert.rejects(x.service.saveDraft({sessionRef:x.sessionRef,baseVersion:0,requestId:randomUUID(),...x.snapshot,overview:'Ghi đè'}),e=>e.code==='DRAFT_VERSION_CONFLICT');
 assert.equal((await x.service.sessionDetails(x.sessionRef)).overview,x.snapshot.overview);
 const oneBody=await x.service.submitCheck({sessionRef:x.sessionRef,section:'outline',requestId:randomUUID(),snapshot:{...x.snapshot,body2:''}});assert.equal(oneBody.status,'queued');
});
test('public API keeps context private, validates Origin and teacher class scope',async t=>{
 const x=await setup(t);await queue(x);
 await x.pool.query('INSERT INTO task1_private.teacher_grant VALUES($1,$2,$3,true,$4::uuid[])',['test@fixture.invalid','fixture-sub','teacher',[x.classRef]]);
 const config={origins:new Set(['http://fixture.invalid'])};let sub='fixture-sub';
 const app=createApp({...x,config,verifyTeacher:async()=>({email:'test@fixture.invalid',sub})});
 const detail=await request(app).get('/api/v1/sessions/'+x.sessionRef).expect(200);assert.doesNotMatch(JSON.stringify(detail.body),/template|leaseToken|promptSha256|promptVersion/u);
 await request(app).post('/api/v1/internal/grading-jobs/claim').set('Origin','http://fixture.invalid').send({}).expect(404);
 await request(app).post('/api/v1/sessions').set('Origin','http://bad.invalid').send({}).expect(403);
 await request(app).post('/api/v1/sessions').send({}).expect(403);
 await request(app).get('/api/v1/admin/live/sessions/'+x.sessionRef).expect(200);
 await x.pool.query("UPDATE task1_private.teacher_grant SET class_refs='{}'");await request(app).get('/api/v1/admin/live/sessions/'+x.sessionRef).expect(403);
 sub='changed-sub';await request(app).get('/api/v1/admin/me').expect(403);
});
test('teacher and learner exchange anchored comments without changing AI or draft',async t=>{
 const x=await setup(t);await x.service.saveDraft({sessionRef:x.sessionRef,baseVersion:0,requestId:randomUUID(),...x.snapshot});
 const thread=await x.service.comments.create({sessionRef:x.sessionRef,sectionKey:'overview',fieldKey:'overview',start:0,end:4,baseVersion:1,body:'Em đọc lại đơn vị nhé.',requestId:randomUUID(),actorRef:'teacher@fixture.invalid'});
 await x.service.comments.reply({threadRef:thread.threadRef,sessionRef:x.sessionRef,actorRole:'student',actorRef:'student',body:'Em đã xem lại.',requestId:randomUUID()});
 const list=await x.service.comments.list({sessionRef:x.sessionRef});assert.equal(list.threads[0].messages.length,2);assert.equal((await x.service.sessionDetails(x.sessionRef)).comments.length,0);
});
test('PIN access, wrong code and re-entry retain the same learner session',async t=>{
 const x=await setup(t);const created=await x.service.provisional.createStudent({activitySlug:'task1-fixture',classRef:x.classRef,displayName:'Bạn thử PIN',pin:'1234',requestId:randomUUID()});
 await assert.rejects(x.service.openSession({activitySlug:'task1-fixture',classRef:x.classRef,studentRef:created.studentRef,accessCode:'5678'}),e=>e.code==='INVALID_ACCESS_CODE');
 const a=await x.service.openSession({activitySlug:'task1-fixture',classRef:x.classRef,studentRef:created.studentRef,accessCode:'1234'}),b=await x.service.openSession({activitySlug:'task1-fixture',classRef:x.classRef,studentRef:created.studentRef,accessCode:'1234'});assert.equal(a.sessionRef,b.sessionRef);
});
test('response validator rejects rewritten answer, overlong answer and truncated inference',()=>{
 assert.throws(()=>validateFeedback(revision+'\nCâu sửa: A complete sentence.','draft'),/WROTE_FOR_STUDENT/);
 assert.throws(()=>validateFeedback('Em '.repeat(151),'outline'),/TOO_LONG/);
 assert.throws(()=>readModel({candidates:[{finishReason:'MAX_TOKENS',content:{parts:[{text:feedback.draft}]}}]}),/INCOMPLETE/);
 assert.equal(validateFeedback(feedback.draft,'draft'),'passed');
 const long=revision+'\n\n2. **Chẩn đoán:** '+('Em '.repeat(151));assert.equal(normalizeFeedback(long,'draft'),revision);
 const commonStep=revision.split('\n**Next step:')[0]+'\n\n2. **Chẩn đoán:** '+('Em '.repeat(151))+'\n**Next step:** Em sửa hai ý.';
 assert.equal(validateFeedback(normalizeFeedback(commonStep,'draft'),'draft'),'needs_revision');
});
test('production refuses another product DB or missing shared SSO',()=>{
 const env={NODE_ENV:'test',TASK1_DATABASE_URL:'postgres://task1_api:fake@localhost/sw_task1_test',TASK1_INTERNAL_TOKEN:'x'.repeat(32),TASK1_PIN_PEPPER:'x'.repeat(32),TASK1_ALLOWED_ORIGINS:'http://fixture.invalid'};
 assert.equal(loadConfig(env).productId,'sw-task1');assert.throws(()=>loadConfig({...env,TASK1_DATABASE_URL:'postgres://task1_api:fake@localhost/shops_writing'}),/DATABASE_REQUIRED/);
 assert.throws(()=>loadConfig({...env,NODE_ENV:'production'}),/SHARED_SSO_REQUIRED/);
});
test('same Draft regression is RED on pinned upstream and GREEN on isolated Socratic service',async t=>{
 const x=await setup(t);await queue(x,'draft');const [job]=await x.service.claimJobs({workerId:'test',maxJobs:1,leaseSeconds:420});
 const lock=JSON.parse(await fs.readFile(new URL('../vendor-lock.json',import.meta.url),'utf8'));
 let upstream=await fs.readFile(new URL('../../backend/src/service.js',import.meta.url),'utf8');assert.equal(sha(upstream.replaceAll('\r\n','\n')),lock.files['service.js'].upstream_sha256);
 upstream=upstream.replace("'./db.js'",JSON.stringify(new URL('../vendor/db.js',import.meta.url).href));
 const legacy=await import('data:text/javascript;base64,'+Buffer.from(upstream).toString('base64'));
 const input={jobRef:job.jobRef,leaseToken:job.leaseToken,resultStatus:'needs_revision',feedback:revision,artifacts:{productId:'sw-task1',attemptRef:job.jobRef,mode:'socratic-v2',promptSha256:job.gradingContext.promptSha256,snapshotSha256:sha(job.snapshot)}};
 await assert.rejects(legacy.createWritingPracticeService({pool:x.pool}).completeJob(input),e=>e.code==='DRAFT_LMS_RESULT_REQUIRED');
 await x.service.completeJob(input);assert.equal((await x.service.sessionDetails(x.sessionRef)).sections.draft.failStreak,1);
});
test('partial failure and reverse completion keep two learner results on their own attempts',async t=>{
 const x=await setup(t);await queue(x,'overview');await queue(x,'outline');
 let first=true;const outcomes=await processBatch({service:x.service,aiUrl:'https://fixture.invalid',call:async()=>{
  if(first){first=false;await new Promise(r=>setTimeout(r,30));throw Error('timeout');}
  return modelResponse(feedback.outline);
 }});
 assert.equal(outcomes.filter(v=>v.outcome==='completed').length,1);
 const detail=await x.service.sessionDetails(x.sessionRef);assert.equal(detail.sections.overview.status,'technical_error');assert.equal(detail.sections.outline.status,'passed');
 assert.equal(detail.comments.find(v=>v.section==='outline').feedback,feedback.outline);
 assert.equal(detail.comments.find(v=>v.section==='overview').status,'technical_error');
});
test('runtime SQL role cannot change prompt, grants or foreign schema; it can save and complete',async t=>{
 const x=await setup(t);
 await x.db.exec('CREATE ROLE task1_api; CREATE SCHEMA foreign_product; CREATE TABLE foreign_product.protected(value text);');
 let grants=await fs.readFile(new URL('../db/002-runtime-grants.sql',import.meta.url),'utf8');grants=grants.replace(/^(?:REVOKE ALL ON DATABASE|GRANT CONNECT ON DATABASE).*$/gm,'');
 await x.db.exec(grants);await x.db.exec('SET ROLE task1_api');
 for(const sql of ["SELECT * FROM foreign_product.protected","UPDATE task1_private.prompt SET template='bad'","UPDATE task1_private.teacher_grant SET active=true","DELETE FROM writing_practice.activity_session"]){await assert.rejects(x.pool.query(sql),e=>e.code==='42501');}
 await queue(x);const out=await processBatch({service:x.service,aiUrl:'https://fixture.invalid',call:async()=>modelResponse(feedback.overview)});assert.equal(out[0].outcome,'completed');
 await x.db.exec('RESET ROLE');
});
test('queue wait is not an AI timeout and only an expired active lease becomes technical error',async t=>{
 const x=await setup(t),sent=await queue(x);
 await x.pool.query("UPDATE writing_practice.check_attempt SET created_at=now()-interval '10 minutes'");
 assert.equal((await x.service.getAttempt(sent.attemptRef)).status,'queued');
 await x.service.claimJobs({workerId:'test',maxJobs:1,leaseSeconds:420});
 assert.equal((await x.service.getAttempt(sent.attemptRef)).status,'leased');
 await x.pool.query("UPDATE writing_practice.check_attempt SET lease_expires_at=now()-interval '1 second'");
 assert.equal((await x.service.getAttempt(sent.attemptRef)).errorCode,'TASK1_GRADING_LEASE_EXPIRED');
 assert.equal((await x.service.sessionDetails(x.sessionRef)).sections.overview.failStreak,0);
});
test('students sharing one IP have separate write budgets',async()=>{
 const app=createApp({config:{origins:new Set(['http://fixture.invalid'])},pool:{},service:{submitCheck:async()=>({status:'queued'})}}),a=randomUUID(),b=randomUUID();
 const send=ref=>request(app).post('/api/v1/sessions/'+ref+'/checks').set('Origin','http://fixture.invalid').send({section:'overview',requestId:randomUUID(),snapshot:{overview:'Thử',body1:'',body2:'',draft1:'',draft2:''}});
 for(let i=0;i<60;i++)await send(a).expect(202);
 await send(a).expect(429);await send(b).expect(202);
});
