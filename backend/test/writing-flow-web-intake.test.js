import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { open, seal, sha256 } from '../src/writing-flow-crypto.js';
import { createWebSubstituteIntake } from '../src/writing-flow-web-intake.js';

const key = '11'.repeat(32);
const migrationUrls = [
  '../../docs/migrations/2026-09-24-writing-flow-web-substitute-roster-v16.sql',
  '../../docs/migrations/2026-09-24-writing-flow-web-substitute-intake-v17.sql',
  '../../docs/migrations/2026-09-24-writing-flow-web-substitute-portal-v18.sql',
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

function syntheticSections() {
  const make = type => ({ correct: 1, band: 5, total: 2, answered: 1,
    details: [
      { number: 1, studentAnswer: 'A', correctAnswer: 'A', result: 'correct' },
      { number: 2, studentAnswer: '', correctAnswer: 'B', result: 'blank' },
    ],
    typeStats: [{ type, correct: 1, total: 2, percentage: 0.5 }],
  });
  return { listening: make('Nghe'), reading: make('Đọc') };
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
    await db.exec(`RESET ROLE; UPDATE writing_flow.web_substitute_access
      SET enabled=false WHERE test_slug='substitute-test-2-k56';
      SET ROLE writing_practice_api;`);
    const afterClose = await service.openAttempt(identity());
    assert.equal(afterClose.attemptId, first.attemptId);
    assert.equal(afterClose.status, 'submitted');
    assert.equal((await service.submitWriting(request)).submissionId, receipt.submissionId);
    const status = await service.getStatus({ ...identity(), attemptId: first.attemptId });
    assert.equal(status.submissionId, receipt.submissionId);
    assert.equal(status.submissionStatus, 'pending');
    assert.equal(status.submittedEssay, request.essay);
    assert.equal(status.result, null);
    await assert.rejects(service.getStatus({ ...identity(),
      studentName: 'Học viên khác', attemptId: first.attemptId }),
    error => error.code === 'WEB_ROSTER_NAME_NOT_FOUND');
    await db.exec(`RESET ROLE; INSERT INTO assessment_k56.term_test_roster VALUES
      ('term-test-1-k56',1252,1002,
       '22222222-2222-4222-8222-222222222222','Học viên khác',true);
      SET ROLE writing_practice_api;`);
    await assert.rejects(service.openAttempt({ ...identity(),
      studentName: 'Học viên khác' }),
    error => error.code === 'WEB_TEST_ACCESS_CLOSED');
  } finally {
    await db.close();
  }
});

test('đọc lại kết quả mã hóa chỉ qua đúng lớp và lượt', async () => {
  const { db, pool, getPinnedPrompt } = await fixture();
  try {
    const service = createWebSubstituteIntake({ pool, encryptionKey: key, getPinnedPrompt });
    const attempt = await service.openAttempt(identity());
    const receipt = await service.submitWriting({ ...identity(),
      attemptId: attempt.attemptId, essay: 'Synthetic answer for result readback.' });
    const result = { taskNumber: 1, taskScore: 6.5,
      report: 'Synthetic result, not a student grade.' };
    await db.query(`UPDATE writing_flow.web_substitute_submission
      SET status='completed',result_ciphertext=$2,result_sha256=$3,
        task_score=6.5,completed_at=now()
      WHERE submission_id=$1`, [receipt.submissionId,
      seal(JSON.stringify(result), Buffer.from(key, 'hex')),
      sha256(JSON.stringify(result))]);
    const viewed = await service.getStatus({ ...identity(),
      attemptId: attempt.attemptId });
    assert.equal(viewed.submissionStatus, 'completed');
    assert.equal(viewed.submittedEssay, 'Synthetic answer for result readback.');
    assert.equal(viewed.taskScore, 6.5);
    assert.deepEqual(viewed.result, result);
    await assert.rejects(service.getStatus({ ...identity(), classId: 9999,
      attemptId: attempt.attemptId }),
    error => error.code === 'WEB_TEST_ACCESS_CLOSED');
    await assert.rejects(service.getStatus({ ...identity(),
      attemptId: '33333333-3333-4333-8333-333333333333' }),
    error => error.code === 'WEB_ATTEMPT_NOT_FOUND');
    await db.query(`UPDATE writing_flow.web_substitute_submission
      SET task_score=7 WHERE submission_id=$1`, [receipt.submissionId]);
    await assert.rejects(service.getStatus({ ...identity(),
      attemptId: attempt.attemptId }),
    error => error.code === 'WEB_RESULT_READBACK_MISMATCH');
  } finally {
    await db.close();
  }
});

test('mở lại bằng tên chỉ trả bài đúng lượt; bài lưu hỏng không được hiển thị', async () => {
  const { db, pool, getPinnedPrompt } = await fixture();
  try {
    const service = createWebSubstituteIntake({ pool, encryptionKey: key, getPinnedPrompt });
    const first = await service.openAttempt(identity());
    const receipt = await service.submitWriting({ ...identity(),
      attemptId: first.attemptId, essay: 'Synthetic reopened essay.' });
    await db.exec(`RESET ROLE; INSERT INTO assessment_k56.term_test_roster VALUES
      ('term-test-1-k56',1252,1002,
       '22222222-2222-4222-8222-222222222222','Học viên Hai',true);
      SET ROLE writing_practice_api;`);
    const other = { ...identity(), studentName: 'Học viên Hai' };
    await assert.rejects(service.getStatus({ ...other, attemptId: first.attemptId }),
      error => error.code === 'WEB_ATTEMPT_NOT_FOUND');
    const reopened = await service.openAttempt(identity());
    assert.equal(reopened.attemptId, first.attemptId);
    const status = await service.getStatus({ ...identity(), attemptId: reopened.attemptId });
    assert.equal(status.submittedEssay, 'Synthetic reopened essay.');
    await db.exec('RESET ROLE;');
    await db.query(`UPDATE writing_flow.web_substitute_submission
      SET content_ciphertext=decode('abcd','hex') WHERE submission_id=$1`,
    [receipt.submissionId]);
    await db.exec('SET ROLE writing_practice_api;');
    await assert.rejects(service.getStatus({ ...identity(), attemptId: first.attemptId }),
      error => error.code === 'WEB_CONTENT_READBACK_MISMATCH');
  } finally {
    await db.close();
  }
});

test('kết quả Nghe/Đọc giữ cùng phiếu mã hóa, thiếu/sai số câu không được đoán điểm', async () => {
  const { db, pool, getPinnedPrompt } = await fixture();
  try {
    const service = createWebSubstituteIntake({ pool, encryptionKey: key, getPinnedPrompt });
    const attempt = await service.openAttempt(identity());
    const invalid = syntheticSections();
    invalid.reading.correct = 2;
    await assert.rejects(service.submitWriting({ ...identity(),
      attemptId: attempt.attemptId, essay: 'Synthetic sections essay.',
      sectionResults: invalid }), error => error.code === 'WEB_SECTIONS_INVALID');
    const empty = await db.query(`SELECT count(*)::int AS n
      FROM writing_flow.web_substitute_submission`);
    assert.equal(empty.rows[0].n, 0);
    const sections = syntheticSections();
    await service.submitWriting({ ...identity(), attemptId: attempt.attemptId,
      essay: 'Synthetic sections essay.', sectionResults: sections });
    const reopened = await service.getStatusByName(identity());
    assert.deepEqual(reopened.sectionResults, sections);
    assert.equal(reopened.submittedEssay, 'Synthetic sections essay.');
    await assert.rejects(service.submitWriting({ ...identity(),
      attemptId: attempt.attemptId, essay: 'Synthetic sections essay.' }),
    error => error.code === 'WEB_SUBMISSION_CONFLICT');
  } finally {
    await db.close();
  }
});

test('lượt chấm quá hạn hiện cần kiểm tra, không giả đang chấm mãi', async () => {
  const { db, pool, getPinnedPrompt } = await fixture();
  try {
    const service = createWebSubstituteIntake({ pool, encryptionKey: key, getPinnedPrompt });
    const attempt = await service.openAttempt(identity());
    const receipt = await service.submitWriting({ ...identity(),
      attemptId: attempt.attemptId, essay: 'Synthetic expired work.' });
    await db.query(`UPDATE writing_flow.web_substitute_submission
      SET status='running',attempt_count=1,
        lease_token='77777777-7777-4777-8777-777777777777',
        lease_expires_at=now()-interval '1 minute'
      WHERE submission_id=$1`, [receipt.submissionId]);
    const status = await service.getStatus({ ...identity(),
      attemptId: attempt.attemptId });
    assert.equal(status.submissionStatus, 'needs_review');
    assert.equal(status.result, null);
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

test('đóng đề không nhận bài mới từ lượt còn mở nhưng vẫn đọc lại lượt cũ', async () => {
  const { db, pool, getPinnedPrompt } = await fixture();
  try {
    const service = createWebSubstituteIntake({ pool, encryptionKey: key, getPinnedPrompt });
    const attempt = await service.openAttempt(identity());
    await db.exec(`RESET ROLE; UPDATE writing_flow.web_substitute_access
      SET enabled=false WHERE test_slug='substitute-test-2-k56';
      SET ROLE writing_practice_api;`);
    assert.equal((await service.openAttempt(identity())).attemptId, attempt.attemptId);
    await assert.rejects(service.submitWriting({ ...identity(),
      attemptId: attempt.attemptId, essay: 'Synthetic late answer.' }),
    error => error.code === 'WEB_TEST_ACCESS_CLOSED');
    const submissions = await db.query(`SELECT count(*)::int AS n
      FROM writing_flow.web_substitute_submission`);
    assert.equal(submissions.rows[0].n, 0);
  } finally {
    await db.close();
  }
});
