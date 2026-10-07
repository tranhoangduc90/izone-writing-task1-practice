// Nhận dữ liệu giả; chạy SQL PostgreSQL nhúng và HTTP thật của app dùng chung.
// Kiểm định danh, lease, ngưỡng và lỗi module mới không làm đổi tuyến Writing.
// Không gọi n8n/Google, không ghi production; ca lỗi phải trả mã đúng và giữ dữ liệu.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import express from 'express';
import { mountReadingListening67 } from '../src/reading-listening67/routes.js';
import { createReadingListening67Store, enoughCompletion } from '../src/reading-listening67/store.js';
import { loadReadingListening67Config } from '../src/reading-listening67/config.js';
import { createReadingListening67Runtime } from '../src/reading-listening67/runtime.js';
import { createReadingListening67AccessGuard } from '../src/reading-listening67/database-access.js';
import { createApp } from '../src/app.js';
const doc = 'fixture_document_123456789012345';
const code = '67-reading-02';
const migration = await readFile(new URL('../../docs/migrations/2026-10-07-reading-listening67-v1.sql', import.meta.url), 'utf8');
const permissions = await readFile(new URL('../../docs/migrations/2026-10-07-reading-listening67-permissions.sql', import.meta.url), 'utf8');
const sourceMigration=await readFile(new URL('../../docs/migrations/2026-10-07-reading-listening67-classroom-source.sql',import.meta.url),'utf8');
const scanMigration=await readFile(new URL('../../docs/migrations/2026-10-07-reading-listening67-source-scan.sql',import.meta.url),'utf8');
const dispatchMigration=await readFile(new URL('../../docs/migrations/2026-10-07-reading-listening67-cta-dispatch.sql',import.meta.url),'utf8');
async function database(t) {
  const db = new PGlite();
  await db.exec(migration);
  await db.exec(sourceMigration.replace(/^GRANT .*;$/gm,''));
  await db.exec(scanMigration.replace(/^GRANT .*;$/gm,''));
  await db.exec(dispatchMigration);
  // Sentinel giúp phát hiện đọc/ghi nhầm bảng Writing trong ca SQL thực.
  await db.exec("CREATE SCHEMA writing_flow; CREATE TABLE writing_flow.sentinel (id integer); INSERT INTO writing_flow.sentinel VALUES(7);");
  const c = { query: (...args) => db.query(...args), release() {} };
  const store = createReadingListening67Store({ pool: { ...c, connect: async () => c } });
  t.after(async () => { assert.deepEqual((await db.query('SELECT * FROM writing_flow.sentinel')).rows, [{ id: 7 }]); await db.close(); });
  return { store, db };
}
function app(module = null) {
  const writing = createApp({ config: { trustProxyHops: 0, allowedOrigins: new Set(), internalApiToken: 'w'.repeat(32) }, pool: { query: async () => ({ rows: [] }) }, service: {}, writingFlowService: { syncClassesFromMapping: async () => ({ pairs: 3 }) } });
  if (!module) return writing;
  // Chỉ ghép trong bài kiểm để phát hiện ảnh hưởng chéo; production chạy hai tiến trình riêng.
  const harness = express();
  mountReadingListening67(harness, module);
  harness.use(writing);
  return harness;
}

test('Chỉ lượt đã qua kiểm bài mới chuyển sang ghi; lỗi ghi cần rà lại', async t => {
  const {store}=await database(t);
  await store.accept({documentId:doc,assignmentCode:code,requestId:'q1',jobId:'j1'});
  const c=await store.claim({jobId:'j1',executionId:'e1'});
  await assert.rejects(store.renew({...c,phase:'writing'}),{code:'WRITING_VALIDATION_REQUIRED'});
  await store.validate({...c,sourceRevision:'r1',templateVersion:'v1',graderVersion:'g1',answerSha256:'a'.repeat(64),done:80,total:100});
  await store.renew({...c,phase:'writing'});
  assert.equal((await store.status({jobId:'j1'})).status,'writing');
  await store.executionFailed({jobId:'j1',executionId:'e1',errorCode:'DOCS_WRITE_FAILED'});
  assert.equal((await store.status({jobId:'j1'})).status,'needs_review');
});
test('Ngưỡng 80% dùng tỉ lệ chính xác, không làm tròn lên', () => {
  assert.equal(enoughCompletion(79,100),false); assert.equal(enoughCompletion(80,100),true);
  assert.equal(enoughCompletion(4,5),true); assert.equal(enoughCompletion(5,7),false);
  assert.throws(() => enoughCompletion(1,0), /COMPLETION_INVALID/);
});
test('Không cấu hình mới: Writing khởi động và không cần token/DB Reading', async () => {
  assert.deepEqual(loadReadingListening67Config({}), { enabled:false });
  assert.equal(createReadingListening67Runtime({}).mount,null);
  await request(app()).get('/health').expect(200,{ok:true});
  await request(app()).get('/api/v1/internal/reading-listening67/ready').expect(404);
});
test('Không mượn kết nối và token Writing làm cấu hình Reading', () => {
  assert.throws(()=>loadReadingListening67Config({READING_LISTENING67_ENABLED:'true',INTERNAL_API_TOKEN:'w'.repeat(32),DATABASE_URL:'postgres://writing/db'}),/RL67_TOKEN_REQUIRED/);
  assert.throws(()=>loadReadingListening67Config({READING_LISTENING67_ENABLED:'true',READING_LISTENING67_INTERNAL_TOKEN:'r'.repeat(32),READING_LISTENING67_DATABASE_URL:'postgres://writing/db',DATABASE_URL:'postgres://writing/db'}),/RL67_SEPARATE_DATABASE_ROLE_REQUIRED/);
  const env={READING_LISTENING67_ENABLED:'true',READING_LISTENING67_INTERNAL_TOKEN:'r'.repeat(32),READING_LISTENING67_DATABASE_URL:'postgres://writing:new@other/db',READING_LISTENING67_NOTIFY_URL:'https://example.invalid/jobs'};
  assert.throws(()=>loadReadingListening67Config(env),/RL67_SEPARATE_DATABASE_ROLE_REQUIRED/);
  assert.equal(loadReadingListening67Config({...env,READING_LISTENING67_DATABASE_URL:'postgres://reading_listening67_api:fixture@local/mapping_db'}).poolMax,2);
});
test('Token riêng; lỗi Reading vẫn giữ health và hợp đồng Writing', async () => {
  const a=app({token:'r'.repeat(32),store:{ready:async()=>{throw Error('connection_failed');}}});
  await request(a).get('/api/v1/internal/reading-listening67/ready').set('Authorization','Bearer '+'w'.repeat(32)).expect(401);
  await request(a).get('/api/v1/internal/reading-listening67/ready').set('Authorization','Bearer '+'r'.repeat(32)).expect(503);
  await request(a).get('/health').expect(200,{ok:true});
  await request(a).post('/api/v1/internal/writing-flow/classes/sync-from-mapping').set('Authorization','Bearer '+'w'.repeat(32)).send({}).expect(200,{ok:true,result:{pairs:3}});
});
test('JSON lỗi của Reading trả 400 qua parser riêng, Writing vẫn dùng parser cũ', async () => {
  const a=app({token:'r'.repeat(32),store:{accept:async()=>({})}});
  await request(a).post('/api/v1/internal/reading-listening67/accept').set('Authorization','Bearer '+'r'.repeat(32)).set('Content-Type','application/json').send('{broken').expect(400,{ok:false,error:'RL67_INVALID_JSON'});
  await request(a).post('/api/v1/internal/reading-listening67/accept').set('Authorization','Bearer '+'r'.repeat(32)).send({documentId:doc,assignmentCode:code,requestId:'q1',trackingRecordId:'lark'}).expect(400);
});
test('File ngoài Classroom tự có hồ sơ; bấm lặp trả cùng lượt, khác kỹ năng chờ', async t => {
  const {store,db}=await database(t);
  const one=await store.accept({documentId:doc,assignmentCode:code,requestId:'q1',jobId:'j1'});
  assert.equal(one.jobId,'j1');
  assert.equal((await store.accept({documentId:doc,assignmentCode:code,requestId:'q2'})).jobId,'j1');
  await assert.rejects(store.accept({documentId:doc,assignmentCode:'67-listening-01',requestId:'q3'}),{code:'DOCUMENT_BUSY'});
  assert.equal((await db.query('SELECT source_kind FROM reading_listening67.document_unit')).rows[0].source_kind,'outside_classroom');
  const claimed=await store.claim({jobId:'j1',executionId:'exec1'});
  await assert.rejects(store.claim({jobId:'j1',executionId:'exec2'}),{code:'JOB_NOT_CLAIMABLE'});
  await assert.rejects(store.validate({...claimed,sourceRevision:'r1',templateVersion:'v1',graderVersion:'g1',answerSha256:'a'.repeat(64),done:80,total:100,leaseToken:'11111111-1111-4111-8111-111111111111'}),{code:'LEASE_NOT_OWNED'});
});
test('Đã đủ bài không báo xong nếu chưa xác minh Docs và xóa cảnh báo', async t => {
  const {store}=await database(t);
  await store.accept({documentId:doc,assignmentCode:code,requestId:'q1',jobId:'j1'});
  const c=await store.claim({jobId:'j1',executionId:'e1'});
  const v=await store.validate({...c,sourceRevision:'r1',templateVersion:'v1',graderVersion:'g1',answerSha256:'a'.repeat(64),done:80,total:100});
  assert.equal(v.enough,true);
  const result={...c,status:'done',result:{summary:'ok',count:1},warningState:'absent_verified'};
  await assert.rejects(store.finish(result),{code:'READBACK_PROOF_REQUIRED'});
  const proof={jobId:'j1',documentId:doc,assignmentCode:code,verified:true,revisionId:'r2'};
  await assert.rejects(store.finish({...result,proof:{...proof,documentId:'another_document_123456789012'}}),{code:'READBACK_PROOF_REQUIRED'});
  await store.finish({...result,proof});
  assert.equal((await store.finish({...result,result:{count:1,summary:'ok'},proof})).replayed,true);
  await assert.rejects(store.finish({...result,status:'incomplete',proof}),{code:'RESULT_REPLAY_MISMATCH'});
  assert.equal((await store.status({jobId:'j1'})).status,'done');
});
test('Dưới ngưỡng và lỗi ghi cảnh báo được lưu riêng, lần sửa tiếp tạo lượt mới', async t => {
  const {store}=await database(t);
  await store.accept({documentId:doc,assignmentCode:code,requestId:'q1',jobId:'j1'});
  const c=await store.claim({jobId:'j1',executionId:'e1'});
  assert.equal((await store.validate({...c,sourceRevision:'r1',templateVersion:'v1',graderVersion:'g1',answerSha256:'a'.repeat(64),done:79,total:100})).enough,false);
  await assert.rejects(store.finish({...c,status:'done',warningState:'absent_verified',proof:{jobId:'j1',documentId:doc,assignmentCode:code,verified:true,revisionId:'r2'}}),{code:'DONE_PROOF_INVALID'});
  await store.finish({...c,status:'incomplete',warningState:'write_failed',errorCode:'DOCS_PERMISSION_DENIED',proof:{jobId:'j1',documentId:doc,assignmentCode:code,verified:true,revisionId:'r1'}});
  const status=await store.status({jobId:'j1'});
  assert.equal(status.status,'incomplete'); assert.equal(status.warningState,'write_failed');
  assert.equal((await store.accept({documentId:doc,assignmentCode:code,requestId:'q2',jobId:'j2'})).jobId,'j2');
});
test('Lease hết hạn không tự chấm lại hoặc nhận callback cũ', async t => {
  const {store,db}=await database(t);
  await store.accept({documentId:doc,assignmentCode:code,requestId:'q1',jobId:'j1'});
  const c=await store.claim({jobId:'j1',executionId:'e1'});
  await db.query("UPDATE reading_listening67.job SET lease_expires_at=now()-interval '1 second' WHERE job_id='j1'");
  await assert.rejects(store.renew(c),{code:'LEASE_NOT_OWNED'});
  assert.equal((await store.recoverExpired()).needsReview,1);
  assert.equal((await store.status({jobId:'j1'})).status,'needs_review');
  await assert.rejects(store.finish({...c,status:'done'}),{code:'RESULT_REPLAY_MISMATCH'});
});
test('n8n nhận HTTP nhưng chưa claim: sau sáu lần báo lỗi và cho phép thử lượt mới', async t => {
  const {store,db}=await database(t);
  await store.accept({documentId:doc,assignmentCode:code,requestId:'q1',jobId:'j1'});
  for(let attempt=0;attempt<6;attempt++) {
    assert.equal((await store.dispatchDue()).jobId,'j1');
    await db.query("UPDATE reading_listening67.job SET dispatch_after=now()-interval '1 second' WHERE job_id='j1'");
  }
  assert.equal(await store.dispatchDue(),null);
  assert.equal((await store.recoverExpired()).dispatchFailed,1);
  assert.equal((await store.status({jobId:'j1'})).errorCode,'DISPATCH_NOT_CLAIMED');
  assert.equal((await store.accept({documentId:doc,assignmentCode:code,requestId:'q2',jobId:'j2'})).jobId,'j2');
});
test('Callback không thể đổi tab của bài đã nhận',async t=>{
  const {store}=await database(t);
  await store.accept({documentId:doc,assignmentCode:code,tabId:'t.1',requestId:'q1',jobId:'j1'});
  const c=await store.claim({jobId:'j1',executionId:'e1'});
  await assert.rejects(store.validate({...c,tabId:'t.2',sourceRevision:'r1',templateVersion:'v1',graderVersion:'g1',answerSha256:'a'.repeat(64),done:80,total:100}),{code:'VALIDATION_IDENTITY_MISMATCH'});
});
test('Bổ sung Classroom không ghi đè lớp khác hoặc làm mất lịch sử', async t => {
  const {store,db}=await database(t);
  await store.accept({documentId:doc,assignmentCode:code,requestId:'q1',jobId:'j1'});
  const base={documentId:doc,assignmentCode:code,classroom:{courseId:'course1',courseworkId:'work1',submissionId:'sub1',classCode:'IC-demo-1',sourceEventId:'event1'}};
  await store.register(base); await store.register(base);
  await store.register({...base,classroom:{...base.classroom,courseId:'course2',classCode:'IC-demo-2',sourceEventId:'event2'}});
  assert.equal((await db.query('SELECT count(*)::int AS n FROM reading_listening67.classroom_binding')).rows[0].n,2);
  assert.equal((await db.query('SELECT count(*)::int AS n FROM reading_listening67.job_event')).rows[0].n,1);
});
test('Role thật chỉ ghi vùng Reading/Listening và bị PostgreSQL chặn bảng Writing',async t=>{
  const {db}=await database(t);
  await db.exec(permissions);
  await db.exec(sourceMigration);
  await db.exec(scanMigration);
  await db.exec('SET ROLE reading_listening67_api');
  try {
    const pool={query:(...args)=>db.query(...args)};
    await createReadingListening67AccessGuard(pool)();
    await db.query('SELECT * FROM reading_listening67.job LIMIT 0');
    await assert.rejects(db.query('SELECT * FROM writing_flow.sentinel'),/permission denied/);
    await assert.rejects(db.query('UPDATE writing_flow.sentinel SET id=8'),/permission denied/);
  } finally { await db.exec('RESET ROLE'); }
});
test('Đọc nguồn giữ một lease, lớp lỗi được tổng kết partial và không khóa lần sau',async t=>{
  const {store}=await database(t);const one=await store.scanStart({executionId:'scan1'});assert.ok(one.acquired);
  assert.equal((await store.scanStart({executionId:'scan2'})).acquired,false);
  await assert.rejects(store.scanCourseResult({...one,leaseToken:'11111111-1111-4111-8111-111111111111',courseId:'c1',status:'done'}),{code:'SCAN_LEASE_NOT_OWNED'});
  await store.scanCourseResult({...one,courseId:'c1',status:'done'});await store.scanCourseResult({...one,courseId:'c2',status:'failed',errorCode:'TEST_SOURCE_ERROR'});
  assert.deepEqual(await store.scanFinish(one),{status:'partial',courses:2,failed:1});
  const next=await store.scanStart({executionId:'scan3'});assert.ok(next.acquired);assert.deepEqual(await store.scanFinish(next),{status:'done',courses:0,failed:0});
});
test('Nhóm nguồn nhiều lớp được retry mà không nhân đôi hoặc tráo học viên',async t=>{
  const {store,db}=await database(t);
  const sources=[1,2,3].map(i=>({documentId:'fixture_batch_document_12345678_'+i,classroom:{courseId:'course'+i,courseworkId:'work'+i,submissionId:'sub'+i,studentId:'student'+i,classCode:'Cùng tên',sourceEventId:'batch1'}}));
  const first=await store.sourceBatch({sources});const retry=await store.sourceBatch({sources:sources.toReversed()});
  assert.equal(first.sources.length,3);assert.equal(retry.sources.length,3);assert.equal((await db.query('SELECT count(*)::int AS n FROM reading_listening67.source_document')).rows[0].n,3);
  for(const s of sources){const r=(await db.query('SELECT course_id,student_id FROM reading_listening67.source_document WHERE document_id=$1',[s.documentId])).rows[0];assert.equal(r.course_id,s.classroom.courseId);assert.equal(r.student_id,s.classroom.studentId);}
});
test('Chưa gửi Rabbit vẫn retry; gửi đã xác nhận không xếp CTA lại mỗi giờ',async t=>{
  const {store}=await database(t);
  const input={documentId:doc,classroom:{courseId:'c1',courseworkId:'w1',submissionId:'s1',sourceEventId:'e1'}};
  const first=await store.source(input),unsentRetry=await store.source(input);
  assert.equal(first.ctaNeeded,true);assert.equal(unsentRetry.ctaNeeded,true);
  assert.notEqual(first.dispatchToken,unsentRetry.dispatchToken);
  const s={documentId:doc,courseId:'c1',courseworkId:'w1',submissionId:'s1',dispatchToken:unsentRetry.dispatchToken};
  await assert.rejects(store.sourceCtaEnqueuedBatch({sources:[{...s,dispatchToken:first.dispatchToken}]}),{code:'SOURCE_DISPATCH_IDENTITY_MISMATCH'});
  for(const k of ['documentId','courseId','courseworkId','submissionId'])await assert.rejects(store.sourceCtaEnqueuedBatch({sources:[{...s,[k]:'wrong'}]}),{code:'SOURCE_DISPATCH_IDENTITY_MISMATCH'});
  assert.equal((await store.sourceCtaEnqueuedBatch({sources:[s]})).sources[0].marked,true);
  assert.equal((await store.source(input)).ctaNeeded,false);
  assert.equal((await store.sourceCtaState({documentId:doc})).shouldProcess,true);
});
test('Callback kết thúc/lỗi trước xác nhận gửi không bị ACK muộn khóa retry',async t=>{
  const {store}=await database(t);
  const input={documentId:doc,classroom:{courseId:'c1',courseworkId:'w1',submissionId:'s1',sourceEventId:'e1'}};
  for(const state of ['ready','review','error']){
    await store.sourceCtaResult({documentId:doc,state:'error'});
    const first=await store.source(input);
    await store.sourceCtaResult({documentId:doc,state});
    const s={documentId:doc,courseId:'c1',courseworkId:'w1',submissionId:'s1',dispatchToken:first.dispatchToken};
    assert.equal((await store.sourceCtaEnqueuedBatch({sources:[s]})).sources[0].marked,false);
    assert.equal((await store.source(input)).ctaNeeded,state==='error');
    assert.equal((await store.sourceCtaState({documentId:doc})).shouldProcess,state==='error');
  }
});
test('Nguồn Classroom tới trước/sau lần bấm đầu đều nối đúng lớp, học viên và nhiều mã bài',async t=>{
  const {store,db}=await database(t);
  const classroom={courseId:'course1',courseworkId:'work1',submissionId:'sub1',studentId:'student1',classCode:'IC-demo',sourceEventId:'raw_google_1',homeworkTitle:'Bài thử'};
  await store.source({documentId:doc,classroom});await store.source({documentId:doc,classroom});
  const reading=await store.accept({documentId:doc,assignmentCode:code,requestId:'r1'});
  const unit=(await db.query('SELECT * FROM reading_listening67.document_unit')).rows[0];assert.equal(unit.source_kind,'classroom');
  const binding=(await db.query('SELECT * FROM reading_listening67.classroom_binding')).rows[0];assert.equal(binding.student_id,'student1');assert.equal(binding.coursework_id,'work1');
  assert.equal((await db.query('SELECT count(*)::int AS n FROM reading_listening67.source_document')).rows[0].n,1);
  const other='fixture_other_document_123456789';
  await store.accept({documentId:other,assignmentCode:code,requestId:'r2'});
  await store.source({documentId:other,classroom:{...classroom,submissionId:'sub2'}});
  assert.equal((await db.query('SELECT source_kind FROM reading_listening67.document_unit WHERE document_id=$1',[other])).rows[0].source_kind,'classroom');
  assert.ok(reading.jobId);
});
