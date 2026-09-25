import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createWebSubstituteIntake } from '../src/writing-flow-web-intake.js';
import { createWebSubstituteQueue } from '../src/writing-flow-web-queue.js';
import { createWebSubstitutePortalOutbox } from '../src/writing-flow-web-portal-outbox.js';
import { getPinnedWebPrompt, WEB_SUBSTITUTE_REGISTRY } from '../src/writing-flow-web-registry.js';
import { TEST_TASK_DEFINITIONS } from '../src/writing-flow-test.js';

const base = '/api/v1/internal/writing-flow/web-substitute';
const gatewayToken = 'w'.repeat(32);
const graderToken = 'g'.repeat(32);
const portalToken = 't'.repeat(32);
const key = '11'.repeat(32);
const pinned = WEB_SUBSTITUTE_REGISTRY['substitute-test-2-k56'];
const selected = { testSlug: pinned.testSlug, classId: 1252,
  studentName: 'Học viên thử' };

async function fixture() {
  const db = new PGlite();
  await db.exec(`
    CREATE ROLE writing_practice_api;
    CREATE SCHEMA writing_flow;
    CREATE SCHEMA assessment;
    CREATE SCHEMA assessment_k56;
    CREATE TABLE assessment.term_test_roster (
      test_slug text, erp_course_class_id bigint, erp_student_contact_id bigint,
      student_ref uuid, student_name_snapshot text
    );
    CREATE TABLE assessment_k56.term_test_roster (
      test_slug text, erp_course_class_id bigint, erp_student_contact_id bigint,
      student_ref uuid, student_name_snapshot text, is_eligible boolean
    );
    INSERT INTO assessment_k56.term_test_roster VALUES
      ('term-test-1-k56',1252,1001,
       '11111111-1111-4111-8111-111111111111','Học viên thử',true);
    GRANT USAGE ON SCHEMA writing_flow TO writing_practice_api;
  `);
  for (const path of [
    '../../docs/migrations/2026-09-24-writing-flow-web-substitute-roster-v16.sql',
    '../../docs/migrations/2026-09-24-writing-flow-web-substitute-intake-v17.sql',
    '../../docs/migrations/2026-09-24-writing-flow-web-substitute-portal-v18.sql',
  ]) await db.exec(await readFile(new URL(path, import.meta.url), 'utf8'));
  await db.query(`INSERT INTO writing_flow.web_substitute_access
    (test_slug,cohort,erp_course_class_id,rubric_version,enabled)
    VALUES ($1,56,1252,$2,true)`, [pinned.testSlug, pinned.rubricVersion]);
  await db.exec('SET ROLE writing_practice_api;');
  const pool = {
    connect: async () => ({ query: (...args) => db.query(...args), release() {} }),
    query: (...args) => db.query(...args),
  };
  const app = createApp({
    config: { trustProxyHops: 0, allowedOrigins: new Set(),
      internalApiToken: 'i'.repeat(32), webSubstituteApiToken: gatewayToken,
      webSubstituteGraderToken: graderToken,
      webSubstitutePortalToken: portalToken },
    pool, service: {},
    writingFlowWebIntake: createWebSubstituteIntake({ pool,
      encryptionKey: key, getPinnedPrompt: getPinnedWebPrompt }),
    writingFlowWebQueue: createWebSubstituteQueue({ pool,
      encryptionKey: key, getPinnedPrompt: getPinnedWebPrompt }),
    writingFlowWebPortal: createWebSubstitutePortalOutbox({ pool,
      encryptionKey: key }),
  });
  return { db, app };
}

function syntheticTaskResult(taskNumber) {
  return { taskScore: 6.5, report: 'Synthetic report only.',
    criteria: Object.entries(TEST_TASK_DEFINITIONS[taskNumber].criteria)
      .map(([code, components]) => ({ code, bandScore: 6.5,
        feedback: 'Synthetic feedback.', components: components.map(keyCode => ({
          code: keyCode, summary: 'Synthetic summary.', feedback: 'Synthetic feedback.',
        })) })) };
}

function syntheticTask1Result() {
  return syntheticTaskResult(1);
}

function provenOldTask1Result() {
  const result = syntheticTask1Result();
  result.criteria[0].components[0].code = 'ta_overview';
  result.criteria[0].components[1].code = 'ta_data';
  return result;
}

function syntheticSections() {
  const make = (type, correct) => ({ correct, band: 5, total: 40, answered: 40,
    details: Array.from({ length: 40 }, (_, index) => ({ number: index + 1,
      studentAnswer: index < correct ? 'A' : 'B', correctAnswer: 'A',
      result: index < correct ? 'correct' : 'incorrect' })),
    typeStats: [{ type, correct, total: 40, percentage: correct / 40 }],
  });
  return { listening: make('Nghe', 26), reading: make('Đọc', 28) };
}

// Dữ liệu vào: tên và bài viết giả; database in-process, không gọi n8n/Portal thật.
// Việc chính: chạy API thật từ lượt → phiếu → job → callback → xem kết quả.
// Kết quả: duy nhất một bài/kết quả đúng lớp/Task; khóa gateway không lấy việc.
// Khi lỗi: không báo đã nhận/chấm xong nếu chưa có readback.
test('HTTP đầy đủ Substitute dùng cùng phiếu và trả đúng kết quả', async () => {
  const { db, app } = await fixture();
  try {
    const notStarted = await request(app).post(`${base}/status-by-name`)
      .set('Authorization', `Bearer ${gatewayToken}`).send(selected);
    assert.equal(notStarted.status, 200);
    assert.equal(notStarted.body.status, null);
    const beforeRows = await db.query(`SELECT count(*)::int AS n
      FROM writing_flow.web_substitute_attempt`);
    assert.equal(beforeRows.rows[0].n, 0);
    const opened = await request(app).post(`${base}/attempts`)
      .set('Authorization', `Bearer ${gatewayToken}`).send(selected);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.attempt.taskNumber, 1);
    const attemptId = opened.body.attempt.attemptId;
    const submission = { ...selected, attemptId, taskNumber: 1,
      essay: 'Synthetic Task 1 response for full HTTP test.',
      sectionResults: syntheticSections() };
    const accepted = await request(app).post(`${base}/submissions`)
      .set('Authorization', `Bearer ${gatewayToken}`).send(submission);
    assert.equal(accepted.status, 202);
    const repeated = await request(app).post(`${base}/submissions`)
      .set('Authorization', `Bearer ${gatewayToken}`).send(submission);
    assert.equal(repeated.body.receipt.submissionId,
      accepted.body.receipt.submissionId);
    const before = await request(app).post(`${base}/status`)
      .set('Authorization', `Bearer ${gatewayToken}`)
      .send({ ...selected, attemptId });
    assert.equal(before.body.status.submissionStatus, 'pending');
    assert.equal(before.body.status.submittedEssay, submission.essay);
    assert.deepEqual(before.body.status.sectionResults, submission.sectionResults);
    const reopenedByName = await request(app).post(`${base}/status-by-name`)
      .set('Authorization', `Bearer ${gatewayToken}`).send(selected);
    assert.equal(reopenedByName.status, 200);
    assert.equal(reopenedByName.body.status.attemptId, attemptId);
    assert.equal(reopenedByName.body.status.submittedEssay, submission.essay);
    const deniedClaim = await request(app).post(`${base}/work/claim`)
      .set('Authorization', `Bearer ${gatewayToken}`).send({ limit: 1 });
    assert.equal(deniedClaim.status, 401);
    const claimed = await request(app).post(`${base}/work/claim`)
      .set('Authorization', `Bearer ${graderToken}`).send({ limit: 1 });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.jobs.length, 1);
    const job = claimed.body.jobs[0];
    assert.equal(job.promptSha256, pinned.promptSha256);
    assert.equal(job.imageSha256, pinned.imageSha256);
    assert.equal(job.erpStudentId, 1001);
    const wrongClass = await request(app).post(`${base}/work/complete`)
      .set('Authorization', `Bearer ${graderToken}`)
      .send({ ...job, classId: 9999, result: syntheticTask1Result() });
    assert.equal(wrongClass.status, 409);
    const completed = await request(app).post(`${base}/work/complete`)
      .set('Authorization', `Bearer ${graderToken}`)
      .send({ ...job, result: provenOldTask1Result() });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.receipt.taskScore, 6.5);
    const viewed = await request(app).post(`${base}/status`)
      .set('Authorization', `Bearer ${gatewayToken}`)
      .send({ ...selected, attemptId });
    assert.equal(viewed.status, 200);
    assert.equal(viewed.body.status.submissionStatus, 'completed');
    assert.equal(viewed.body.status.portalSyncStatus, 'pending');
    assert.equal(viewed.body.status.submittedEssay, submission.essay);
    assert.deepEqual(viewed.body.status.sectionResults, submission.sectionResults);
    assert.equal(viewed.body.status.result.criteria.length, 4);
    assert.deepEqual(viewed.body.status.result.criteria[0].components.map(item => item.code),
      ['ta_key_features_overview', 'ta_data_support']);
    const deniedPortal = await request(app).post(`${base}/portal/claim`)
      .set('Authorization', `Bearer ${graderToken}`).send({ limit: 1 });
    assert.equal(deniedPortal.status, 401);
    const portalClaim = await request(app).post(`${base}/portal/claim`)
      .set('Authorization', `Bearer ${portalToken}`).send({ limit: 1 });
    assert.equal(portalClaim.status, 200);
    assert.equal(portalClaim.body.jobs.length, 1);
    const portalJob = portalClaim.body.jobs[0];
    assert.equal(portalJob.request.attemptToken, attemptId);
    assert.equal(portalJob.request.commit, false);
    assert.deepEqual(portalJob.request.grades,
      { listening: 26, reading: 28, writing: 6.5 });
    assert.equal(JSON.stringify(portalJob).includes(submission.essay), false);
    const portalResult = { ok: true, status: 'synced', externalWrite: true,
      classCode: 'IC2264', classId: 1252, studentId: 1001,
      attemptToken: attemptId,
      actualScores: portalJob.request.grades,
      portalScores: portalJob.request.grades,
      portalFields: {
        'Term Test 2 Listening (Thi lại)': 26,
        'Term Test 2 Reading (Thi lại)': 28,
        'Term Test 2 Writing (Thi lại)': 6.5,
      } };
    const portalDone = await request(app).post(`${base}/portal/complete`)
      .set('Authorization', `Bearer ${portalToken}`)
      .send({ submissionId: job.submissionId,
        leaseToken: portalJob.leaseToken, result: portalResult });
    assert.equal(portalDone.status, 200);
    assert.equal(portalDone.body.receipt.status, 'synced');
    assert.equal((await db.query(`SELECT status FROM
      writing_flow.web_substitute_portal_outbox WHERE submission_id=$1`,
    [job.submissionId])).rows[0].status, 'synced');
    const afterPortal = await request(app).post(`${base}/status-by-name`)
      .set('Authorization', `Bearer ${gatewayToken}`).send(selected);
    assert.equal(afterPortal.body.status.portalSyncStatus, 'synced');
    const other = await request(app).post(`${base}/status`)
      .set('Authorization', `Bearer ${gatewayToken}`)
      .send({ ...selected, studentName: 'Người khác', attemptId });
    assert.notEqual(other.status, 200);
    const otherByName = await request(app).post(`${base}/status-by-name`)
      .set('Authorization', `Bearer ${gatewayToken}`)
      .send({ ...selected, studentName: 'Người khác' });
    assert.notEqual(otherByName.status, 200);
    const rows = await db.query(`SELECT count(*)::int AS n
      FROM writing_flow.web_substitute_submission`);
    assert.equal(rows.rows[0].n, 1);
  } finally {
    await db.close();
  }
});

// Dữ liệu vào: hai lớp có học viên cùng tên, nộp hai bài giả khác nhau.
// Việc chính: nhận việc chung rồi trả kết quả theo thứ tự đảo ngược.
// Kết quả: chọn lại tên chỉ mở đúng bài/kết quả của lớp tương ứng.
// Khi lỗi: callback tráo lớp bị chặn, không ghi đè hoặc lộ bài lớp khác.
test('Substitute cùng tên ở hai lớp không tráo bài khi chấm đảo thứ tự', async () => {
  const { db, app } = await fixture();
  try {
    await db.exec(`RESET ROLE;
      INSERT INTO assessment_k56.term_test_roster VALUES
        ('term-test-1-k56',1253,1002,
         '22222222-2222-4222-8222-222222222222','Học viên thử',true);
      INSERT INTO writing_flow.web_substitute_access
        (test_slug,cohort,erp_course_class_id,rubric_version,enabled)
      VALUES ('substitute-test-2-k56',56,1253,
        'substitute-test2-k56-isolated-20260917-v1',true);
      SET ROLE writing_practice_api;`);
    const entries = [
      { identity: { ...selected }, studentId: 1001, essay: 'Bài giả riêng của lớp 1252.' },
      { identity: { ...selected, classId: 1253 }, studentId: 1002,
        essay: 'Bài giả riêng của lớp 1253.' },
    ];
    for (const entry of entries) {
      const opened = await request(app).post(`${base}/attempts`)
        .set('Authorization', `Bearer ${gatewayToken}`).send(entry.identity);
      assert.equal(opened.status, 200);
      entry.attemptId = opened.body.attempt.attemptId;
      const accepted = await request(app).post(`${base}/submissions`)
        .set('Authorization', `Bearer ${gatewayToken}`)
        .send({ ...entry.identity, attemptId: entry.attemptId,
          taskNumber: 1, essay: entry.essay, sectionResults: syntheticSections() });
      assert.equal(accepted.status, 202);
      entry.submissionId = accepted.body.receipt.submissionId;
    }
    assert.notEqual(entries[0].attemptId, entries[1].attemptId);
    assert.notEqual(entries[0].submissionId, entries[1].submissionId);
    const crossedSubmission = await request(app).post(`${base}/submissions`)
      .set('Authorization', `Bearer ${gatewayToken}`)
      .send({ ...entries[1].identity, attemptId: entries[0].attemptId,
        taskNumber: 1, essay: 'Bài giả không được nhận của lớp khác.',
        sectionResults: syntheticSections() });
    assert.equal(crossedSubmission.status, 409);
    const claimed = await request(app).post(`${base}/work/claim`)
      .set('Authorization', `Bearer ${graderToken}`).send({ limit: 2 });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.jobs.length, 2);
    const jobs = new Map(claimed.body.jobs.map(job => [job.classId, job]));
    for (const entry of entries) {
      const job = jobs.get(entry.identity.classId);
      assert.equal(job.submissionId, entry.submissionId);
      assert.equal(job.attemptId, entry.attemptId);
      assert.equal(job.erpStudentId, entry.studentId);
      assert.equal(job.essay, entry.essay);
    }
    const crossed = await request(app).post(`${base}/work/complete`)
      .set('Authorization', `Bearer ${graderToken}`)
      .send({ ...jobs.get(1252), classId: 1253, result: syntheticTask1Result() });
    assert.equal(crossed.status, 409);
    for (const entry of [...entries].reverse()) {
      const result = syntheticTask1Result();
      result.report = `Kết quả giả riêng của lớp ${entry.identity.classId}.`;
      const completed = await request(app).post(`${base}/work/complete`)
        .set('Authorization', `Bearer ${graderToken}`)
        .send({ ...jobs.get(entry.identity.classId), result });
      assert.equal(completed.status, 200);
    }
    for (const entry of entries) {
      const reopened = await request(app).post(`${base}/status-by-name`)
        .set('Authorization', `Bearer ${gatewayToken}`).send(entry.identity);
      assert.equal(reopened.status, 200);
      assert.equal(reopened.body.status.attemptId, entry.attemptId);
      assert.equal(reopened.body.status.submissionId, entry.submissionId);
      assert.equal(reopened.body.status.submittedEssay, entry.essay);
      assert.equal(reopened.body.status.result.report,
        `Kết quả giả riêng của lớp ${entry.identity.classId}.`);
    }
    const crossedRead = await request(app).post(`${base}/status`)
      .set('Authorization', `Bearer ${gatewayToken}`)
      .send({ ...entries[1].identity, attemptId: entries[0].attemptId });
    assert.equal(crossedRead.status, 404);
    const count = await db.query(`SELECT count(*)::int AS n
      FROM writing_flow.web_substitute_submission`);
    assert.equal(count.rows[0].n, 2);
  } finally {
    await db.close();
  }
});

// Dữ liệu vào: bốn đề Substitute và bài viết giả của hai khóa; không gọi dịch vụ ngoài.
// Việc chính: nộp xen kẽ, nhận việc chung, thử tráo lượt rồi chấm đảo thứ tự.
// Kết quả: mỗi đề giữ đúng học viên, Task, prompt, ảnh và kết quả của chính nó.
// Khi lỗi: không công nhận callback sai nguồn hoặc tạo thêm bài; Portal kiểm riêng.
test('bốn Substitute giữ định danh nguồn đến kết quả khi chấm đảo thứ tự', async () => {
  const { db, app } = await fixture();
  try {
    await db.exec(`RESET ROLE;
      INSERT INTO assessment.term_test_roster VALUES
        ('term-test-1-k67',2254,2001,
         '33333333-3333-4333-8333-333333333333','Học viên thử');
      INSERT INTO writing_flow.web_substitute_access
        (test_slug,cohort,erp_course_class_id,rubric_version,enabled)
      VALUES
        ('substitute-test-1-k56',56,1252,
         'substitute-test1-k56-isolated-20260915-v1',true),
        ('substitute-test-1-k67',67,2254,
         'test56-67-parity-20260908-v1',true),
        ('substitute-test-2-k67',67,2254,
         'test56-67-parity-20260909-v1',true);
      SET ROLE writing_practice_api;`);
    const entries = Object.values(WEB_SUBSTITUTE_REGISTRY).map((profile, index) => ({
      profile,
      identity: { testSlug: profile.testSlug,
        classId: profile.testSlug.endsWith('k56') ? 1252 : 2254,
        studentName: 'Học viên thử' },
      studentId: profile.testSlug.endsWith('k56') ? 1001 : 2001,
      essay: `Bài viết giả riêng cho đề ${index + 1}.`,
    }));
    for (const entry of entries) {
      const opened = await request(app).post(`${base}/attempts`)
        .set('Authorization', `Bearer ${gatewayToken}`).send(entry.identity);
      assert.equal(opened.status, 200, entry.profile.testSlug);
      entry.attemptId = opened.body.attempt.attemptId;
      assert.equal(opened.body.attempt.taskNumber, entry.profile.taskNumber);
      const payload = { ...entry.identity, attemptId: entry.attemptId,
        taskNumber: entry.profile.taskNumber, essay: entry.essay,
        sectionResults: syntheticSections() };
      const accepted = await request(app).post(`${base}/submissions`)
        .set('Authorization', `Bearer ${gatewayToken}`).send(payload);
      assert.equal(accepted.status, 202, entry.profile.testSlug);
      entry.submissionId = accepted.body.receipt.submissionId;
      const duplicate = await request(app).post(`${base}/submissions`)
        .set('Authorization', `Bearer ${gatewayToken}`).send(payload);
      assert.equal(duplicate.status, 202);
      assert.equal(duplicate.body.receipt.submissionId, entry.submissionId);
    }
    assert.equal(new Set(entries.map(entry => entry.attemptId)).size, 4);
    assert.equal(new Set(entries.map(entry => entry.submissionId)).size, 4);
    const k56Task1 = entries.find(entry => entry.profile.testSlug === 'substitute-test-2-k56');
    const k56Task2 = entries.find(entry => entry.profile.testSlug === 'substitute-test-1-k56');
    const crossedAttempt = await request(app).post(`${base}/submissions`)
      .set('Authorization', `Bearer ${gatewayToken}`)
      .send({ ...k56Task2.identity, attemptId: k56Task1.attemptId,
        taskNumber: 2, essay: 'Bài giả không được nhận.',
        sectionResults: syntheticSections() });
    assert.equal(crossedAttempt.status, 409);
    const claimed = await request(app).post(`${base}/work/claim`)
      .set('Authorization', `Bearer ${graderToken}`).send({ limit: 4 });
    assert.equal(claimed.status, 200);
    assert.equal(claimed.body.jobs.length, 4);
    const jobs = new Map(claimed.body.jobs.map(job => [job.testSlug, job]));
    for (const entry of entries) {
      const job = jobs.get(entry.profile.testSlug);
      assert.ok(job, entry.profile.testSlug);
      assert.equal(job.submissionId, entry.submissionId);
      assert.equal(job.attemptId, entry.attemptId);
      assert.equal(job.classId, entry.identity.classId);
      assert.equal(job.erpStudentId, entry.studentId);
      assert.equal(job.taskNumber, entry.profile.taskNumber);
      assert.equal(job.rubricVersion, entry.profile.rubricVersion);
      assert.equal(job.promptSha256, entry.profile.promptSha256);
      assert.equal(job.imageSha256, entry.profile.imageSha256);
      assert.equal(job.imageUrl, entry.profile.imageUrl);
      assert.equal(job.essay, entry.essay);
    }
    const crossedCallback = await request(app).post(`${base}/work/complete`)
      .set('Authorization', `Bearer ${graderToken}`)
      .send({ ...jobs.get(k56Task1.profile.testSlug),
        testSlug: k56Task2.profile.testSlug, result: syntheticTask1Result() });
    assert.equal(crossedCallback.status, 409);
    for (const entry of [...entries].reverse()) {
      const result = syntheticTaskResult(entry.profile.taskNumber);
      result.report = `Kết quả giả riêng cho ${entry.profile.testSlug}.`;
      const job = jobs.get(entry.profile.testSlug);
      const completed = await request(app).post(`${base}/work/complete`)
        .set('Authorization', `Bearer ${graderToken}`).send({ ...job, result });
      assert.equal(completed.status, 200, entry.profile.testSlug);
      const duplicate = await request(app).post(`${base}/work/complete`)
        .set('Authorization', `Bearer ${graderToken}`).send({ ...job, result });
      assert.equal(duplicate.status, 200, entry.profile.testSlug);
      assert.equal(duplicate.body.receipt.submissionId, entry.submissionId);
    }
    for (const entry of entries) {
      const reopened = await request(app).post(`${base}/status-by-name`)
        .set('Authorization', `Bearer ${gatewayToken}`).send(entry.identity);
      assert.equal(reopened.status, 200, entry.profile.testSlug);
      assert.equal(reopened.body.status.attemptId, entry.attemptId);
      assert.equal(reopened.body.status.submissionId, entry.submissionId);
      assert.equal(reopened.body.status.submittedEssay, entry.essay);
      assert.equal(reopened.body.status.result.taskNumber, entry.profile.taskNumber);
      assert.equal(reopened.body.status.result.report,
        `Kết quả giả riêng cho ${entry.profile.testSlug}.`);
    }
    const rows = await db.query(`SELECT count(*)::int AS n
      FROM writing_flow.web_substitute_submission`);
    assert.equal(rows.rows[0].n, 4);
  } finally {
    await db.close();
  }
});
