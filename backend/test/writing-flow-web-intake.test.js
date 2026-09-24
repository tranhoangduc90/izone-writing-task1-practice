import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { open, sha256 } from '../src/writing-flow-crypto.js';
import { createWebSubstituteIntake } from '../src/writing-flow-web-intake.js';

const key = '11'.repeat(32);
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
    CREATE TABLE writing_flow.pair (pair_id uuid PRIMARY KEY);
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
    VALUES ('substitute-test-2-k56',56,1252,'pizza-v1',true);`);
  await db.exec('SET ROLE writing_practice_api;');
  const pool = {
    connect: async () => ({ query: (...args) => db.query(...args), release() {} }),
    query: (...args) => db.query(...args),
  };
  const topic = 'The graph shows the revenue of three pizza places.';
  const getPinnedPrompt = ({ testSlug, taskNumber, rubricVersion }) => ({
    testSlug, taskNumber, rubricVersion,
    topic,
    imageUrl: 'https://ducizone.ddns.net/writing-assets/v1/pizza-fixture.png',
    promptSha256: sha256(topic), imageSha256: 'b'.repeat(64),
  });
  return { db, pool, getPinnedPrompt };
}

function identity() {
  return { testSlug: 'substitute-test-2-k56', classId: 1252,
    studentName: 'Học viên thử' };
}

// Dữ liệu vào: hai lần nộp một bài giả, không dùng bài/định danh thật.
// Việc chính: kiểm commit, đọc lại, mã hóa, idempotency và khóa lớp–Task.
// Kết quả: chỉ một phiếu nhận kiêm việc chờ; gửi nội dung khác bị từ chối.
// Khi lỗi: không trả accepted giả hoặc ghi bài sang lượt khác.
test('lượt do server cấp và phiếu nhận bài mã hóa sống qua gửi lặp', async () => {
  const { db, pool, getPinnedPrompt } = await fixture();
  try {
    const service = createWebSubstituteIntake({ pool, encryptionKey: key, getPinnedPrompt });
    const first = await service.openAttempt(identity());
    const reopened = await service.openAttempt(identity());
    assert.equal(reopened.attemptId, first.attemptId);
    assert.equal(first.status, 'open');
    assert.equal(first.taskNumber, 1);
    const request = { ...identity(), attemptId: first.attemptId,
      taskNumber: 1, essay: 'Synthetic Task 1 response for regression testing.' };
    const receipt = await service.submitWriting(request);
    const replay = await service.submitWriting(request);
    assert.equal(receipt.submissionId, replay.submissionId);
    assert.equal(receipt.status, 'pending');
    assert.equal(Object.hasOwn(receipt, 'runKey'), false);
    const stored = await db.query(`SELECT content_ciphertext,content_sha256,
      prompt_sha256,image_sha256,run_key,status FROM writing_flow.web_substitute_submission`);
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].status, 'pending');
    assert.equal(stored.rows[0].prompt_sha256.trim(), sha256(
      'The graph shows the revenue of three pizza places.'));
    const decoded = JSON.parse(open(stored.rows[0].content_ciphertext,
      Buffer.from(key, 'hex')));
    assert.equal(decoded.essay, request.essay);
    assert.equal(decoded.taskNumber, 1);
    assert.notEqual(stored.rows[0].content_ciphertext.toString('utf8'), request.essay);
    const attempt = await db.query(`SELECT status FROM writing_flow.web_substitute_attempt`);
    assert.equal(attempt.rows[0].status, 'submitted');
    await assert.rejects(service.submitWriting({ ...request, essay: 'Different essay.' }),
      error => error.code === 'WEB_SUBMISSION_CONFLICT');
    await assert.rejects(service.submitWriting({ ...request, taskNumber: 2 }),
      error => error.code === 'WEB_TASK_MISMATCH');
    await assert.rejects(service.submitWriting({ ...request,
      attemptId: '22222222-2222-4222-8222-222222222222' }),
    error => error.code === 'WEB_ATTEMPT_IDENTITY_MISMATCH');
  } finally {
    await db.close();
  }
});

test('mất phản hồi đọc lại không biến bài đã commit thành bài mới', async () => {
  const { db, pool, getPinnedPrompt } = await fixture();
  try {
    const service = createWebSubstituteIntake({ pool, encryptionKey: key, getPinnedPrompt });
    const attempt = await service.openAttempt(identity());
    const request = { ...identity(), attemptId: attempt.attemptId,
      essay: 'Synthetic answer for readback failure.' };
    const originalQuery = pool.query;
    let failOnce = true;
    pool.query = (sql, values) => {
      if (failOnce && String(sql).includes('SELECT submission_id,attempt_id,task_number,')) {
        failOnce = false;
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      return originalQuery(sql, values);
    };
    await assert.rejects(service.submitWriting(request),
      error => error.code === 'WEB_RECEIPT_READBACK_UNKNOWN');
    const retry = await service.submitWriting(request);
    assert.equal(retry.status, 'pending');
    const count = await db.query(`SELECT count(*)::int AS n
      FROM writing_flow.web_substitute_submission`);
    assert.equal(count.rows[0].n, 1);
  } finally {
    await db.close();
  }
});

test('đề hoặc ảnh chưa ghim đúng dừng trước phiếu nhận', async () => {
  const { db, pool, getPinnedPrompt } = await fixture();
  try {
    const service = createWebSubstituteIntake({ pool, encryptionKey: key,
      getPinnedPrompt: input => ({ ...getPinnedPrompt(input),
        promptSha256: 'c'.repeat(64) }) });
    await assert.rejects(service.openAttempt(identity()),
      error => error.code === 'WEB_PROMPT_PIN_MISMATCH');
    const attempts = await db.query(`SELECT count(*)::int AS n
      FROM writing_flow.web_substitute_attempt`);
    assert.equal(attempts.rows[0].n, 0);
    const valid = createWebSubstituteIntake({ pool, encryptionKey: key,
      getPinnedPrompt });
    const attempt = await valid.openAttempt(identity());
    await assert.rejects(service.submitWriting({ ...identity(),
      attemptId: attempt.attemptId, essay: 'Synthetic answer.' }),
    error => error.code === 'WEB_PROMPT_PIN_MISMATCH');
    const count = await db.query(`SELECT count(*)::int AS n
      FROM writing_flow.web_substitute_submission`);
    assert.equal(count.rows[0].n, 0);
    const other = createWebSubstituteIntake({ pool, encryptionKey: key,
      getPinnedPrompt: input => ({ ...getPinnedPrompt(input),
        testSlug: 'substitute-test-1-k56' }) });
    await assert.rejects(other.submitWriting({ ...identity(),
      attemptId: attempt.attemptId, essay: 'Synthetic answer.' }),
    error => error.code === 'WEB_PROMPT_PIN_MISMATCH');
  } finally {
    await db.close();
  }
});

test('không có khóa mã hóa hoặc quyền lớp thì không cấp lượt', async () => {
  const { db, pool, getPinnedPrompt } = await fixture();
  try {
    const unready = createWebSubstituteIntake({ pool, encryptionKey: '', getPinnedPrompt });
    await assert.rejects(unready.openAttempt(identity()),
      error => error.code === 'WEB_INTAKE_NOT_READY');
    const service = createWebSubstituteIntake({ pool, encryptionKey: key, getPinnedPrompt });
    await assert.rejects(service.openAttempt({ ...identity(), classId: 9999 }),
      error => error.code === 'WEB_TEST_ACCESS_CLOSED');
    const count = await db.query(`SELECT count(*)::int AS n
      FROM writing_flow.web_substitute_attempt`);
    assert.equal(count.rows[0].n, 0);
  } finally {
    await db.close();
  }
});
