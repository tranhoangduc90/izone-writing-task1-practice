import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { createWebSubstituteIntake } from '../src/writing-flow-web-intake.js';
import { createWebSubstituteQueue } from '../src/writing-flow-web-queue.js';
import { getPinnedWebPrompt, WEB_SUBSTITUTE_REGISTRY } from '../src/writing-flow-web-registry.js';
import { TEST_TASK_DEFINITIONS } from '../src/writing-flow-test.js';

const base = '/api/v1/internal/writing-flow/web-substitute';
const gatewayToken = 'w'.repeat(32);
const graderToken = 'g'.repeat(32);
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
      webSubstituteGraderToken: graderToken },
    pool, service: {},
    writingFlowWebIntake: createWebSubstituteIntake({ pool,
      encryptionKey: key, getPinnedPrompt: getPinnedWebPrompt }),
    writingFlowWebQueue: createWebSubstituteQueue({ pool,
      encryptionKey: key, getPinnedPrompt: getPinnedWebPrompt }),
  });
  return { db, app };
}

function syntheticTask1Result() {
  return { taskScore: 6.5, report: 'Synthetic report only.',
    criteria: Object.entries(TEST_TASK_DEFINITIONS[1].criteria)
      .map(([code, components]) => ({ code, bandScore: 6.5,
        feedback: 'Synthetic feedback.', components: components.map(keyCode => ({
          code: keyCode, summary: 'Synthetic summary.', feedback: 'Synthetic feedback.',
        })) })) };
}

// Dữ liệu vào: tên và bài viết giả; database in-process, không gọi n8n/Portal thật.
// Việc chính: chạy API thật từ lượt → phiếu → job → callback → xem kết quả.
// Kết quả: duy nhất một bài/kết quả đúng lớp/Task; khóa gateway không lấy việc.
// Khi lỗi: không báo đã nhận/chấm xong nếu chưa có readback.
test('HTTP đầy đủ Substitute dùng cùng phiếu và trả đúng kết quả', async () => {
  const { db, app } = await fixture();
  try {
    const opened = await request(app).post(`${base}/attempts`)
      .set('Authorization', `Bearer ${gatewayToken}`).send(selected);
    assert.equal(opened.status, 200);
    assert.equal(opened.body.attempt.taskNumber, 1);
    const attemptId = opened.body.attempt.attemptId;
    const submission = { ...selected, attemptId, taskNumber: 1,
      essay: 'Synthetic Task 1 response for full HTTP test.' };
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
      .send({ ...job, result: syntheticTask1Result() });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.receipt.taskScore, 6.5);
    const viewed = await request(app).post(`${base}/status`)
      .set('Authorization', `Bearer ${gatewayToken}`)
      .send({ ...selected, attemptId });
    assert.equal(viewed.status, 200);
    assert.equal(viewed.body.status.submissionStatus, 'completed');
    assert.equal(viewed.body.status.submittedEssay, submission.essay);
    assert.equal(viewed.body.status.result.criteria.length, 4);
    const other = await request(app).post(`${base}/status`)
      .set('Authorization', `Bearer ${gatewayToken}`)
      .send({ ...selected, studentName: 'Người khác', attemptId });
    assert.notEqual(other.status, 200);
    const rows = await db.query(`SELECT count(*)::int AS n
      FROM writing_flow.web_substitute_submission`);
    assert.equal(rows.rows[0].n, 1);
  } finally {
    await db.close();
  }
});
