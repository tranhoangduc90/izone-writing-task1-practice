import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { sha256 } from '../src/writing-flow-crypto.js';
import { createWebSubstituteIntake } from '../src/writing-flow-web-intake.js';
import { createWebSubstituteQueue } from '../src/writing-flow-web-queue.js';
import { TEST_TASK_DEFINITIONS } from '../src/writing-flow-test.js';

const key = '11'.repeat(32);
const identity = { testSlug: 'substitute-test-2-k56', classId: 1252,
  studentName: 'Học viên thử' };
const migrationUrls = [
  '../../docs/migrations/2026-09-24-writing-flow-web-substitute-roster-v16.sql',
  '../../docs/migrations/2026-09-24-writing-flow-web-substitute-intake-v17.sql',
].map(path => new URL(path, import.meta.url));

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
  for (const url of migrationUrls) await db.exec(await readFile(url, 'utf8'));
  await db.exec(`INSERT INTO writing_flow.web_substitute_access
    (test_slug,cohort,erp_course_class_id,rubric_version,enabled)
    VALUES ('substitute-test-2-k56',56,1252,'pizza-v1',true);
    SET ROLE writing_practice_api;`);
  const pool = {
    connect: async () => ({ query: (...args) => db.query(...args), release() {} }),
    query: (...args) => db.query(...args),
  };
  const topic = 'The graph shows the revenue of three pizza places.';
  const getPinnedPrompt = ({ testSlug, taskNumber, rubricVersion }) => ({
    testSlug, taskNumber, rubricVersion, topic,
    imageUrl: 'https://ducizone.ddns.net/writing-assets/v1/pizza-fixture.png',
    promptSha256: sha256(topic), imageSha256: 'b'.repeat(64),
  });
  const intake = createWebSubstituteIntake({ pool, encryptionKey: key, getPinnedPrompt });
  const queue = createWebSubstituteQueue({ pool, encryptionKey: key, getPinnedPrompt });
  return { db, pool, intake, queue };
}

function task1Result(score = 6.5) {
  const criteria = Object.entries(TEST_TASK_DEFINITIONS[1].criteria).map(
    ([code, componentCodes]) => ({ code, bandScore: score, feedback: 'Synthetic feedback.',
      components: componentCodes.map(componentCode => ({ code: componentCode,
        summary: 'Synthetic summary.', feedback: 'Synthetic feedback.' })) }));
  return { criteria, taskScore: score, report: 'Synthetic report.' };
}

// Dữ liệu vào: một bài giả từ phiếu đã commit trong PostgreSQL thử nghiệm.
// Việc chính: lấy việc đúng một lần, ràng buộc đầy đủ callback và điểm tính lại.
// Kết quả: cùng callback chỉ có một kết quả, xem lại đúng lớp/lượt.
// Khi lỗi: không gọi AI hoặc sửa bài/điểm thật.
test('hàng chờ web lấy một việc và callback đúng identity một lần', async () => {
  const { db, intake, queue } = await fixture();
  try {
    const attempt = await intake.openAttempt(identity);
    const receipt = await intake.submitWriting({ ...identity,
      attemptId: attempt.attemptId, essay: 'Synthetic answer for queue test.' });
    const jobs = await queue.claimDue({ limit: 1 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].submissionId, receipt.submissionId);
    assert.equal(jobs[0].erpStudentId, 1001);
    assert.equal(jobs[0].taskNumber, 1);
    assert.equal(jobs[0].wordCount, 5);
    assert.deepEqual(await queue.claimDue({ limit: 1 }), []);
    const callback = { ...jobs[0], result: task1Result() };
    await assert.rejects(queue.completeWork({ ...callback, classId: 9999 }),
      error => error.code === 'WEB_WORK_IDENTITY_MISMATCH');
    await assert.rejects(queue.completeWork({ ...callback,
      leaseToken: '22222222-2222-4222-8222-222222222222' }),
    error => error.code === 'WEB_WORK_LEASE_STALE');
    const completed = await queue.completeWork(callback);
    assert.equal(completed.status, 'completed');
    assert.equal(completed.taskScore, 6.5);
    assert.deepEqual(await queue.completeWork(callback), completed);
    await assert.rejects(queue.completeWork({ ...callback, result: task1Result(7) }),
      error => error.code === 'WEB_RESULT_CONFLICT');
    const status = await intake.getStatus({ ...identity,
      attemptId: attempt.attemptId });
    assert.equal(status.submissionStatus, 'completed');
    assert.equal(status.taskScore, 6.5);
    assert.equal(status.result.criteria.length, 4);
    const count = await db.query(`SELECT count(*)::int AS n FROM
      writing_flow.web_substitute_submission WHERE status='completed'`);
    assert.equal(count.rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test('lease quá hạn chuyển cần kiểm tra, callback muộn không sửa kết quả', async () => {
  const { db, intake, queue } = await fixture();
  try {
    const attempt = await intake.openAttempt(identity);
    await intake.submitWriting({ ...identity, attemptId: attempt.attemptId,
      essay: 'Synthetic answer for timeout.' });
    const [job] = await queue.claimDue({ limit: 1 });
    await db.query(`UPDATE writing_flow.web_substitute_submission
      SET lease_expires_at=now()-interval '1 minute'
      WHERE submission_id=$1`, [job.submissionId]);
    assert.deepEqual(await queue.markExpiredForReview(), { needsReview: 1 });
    assert.deepEqual(await queue.markExpiredForReview(), { needsReview: 0 });
    await assert.rejects(queue.completeWork({ ...job, result: task1Result() }),
      error => error.code === 'WEB_WORK_LEASE_STALE');
    const status = await intake.getStatus({ ...identity,
      attemptId: attempt.attemptId });
    assert.equal(status.submissionStatus, 'needs_review');
    assert.equal(status.result, null);
  } finally {
    await db.close();
  }
});
