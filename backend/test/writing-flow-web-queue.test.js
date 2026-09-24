import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { sha256 } from '../src/writing-flow-crypto.js';
import { createWebSubstituteIntake } from '../src/writing-flow-web-intake.js';
import { createWebSubstituteQueue,
  normalizeWebSubstituteGradingResult } from '../src/writing-flow-web-queue.js';
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

function provenPizzaTask1Result(score = 6.5) {
  const result = task1Result(score);
  return { ...result, criteria: result.criteria.map(criterion =>
    criterion.code !== 'TA' ? criterion : { ...criterion,
      components: criterion.components.map(component => ({ ...component,
        code: component.code === 'ta_key_features_overview' ? 'ta_overview'
          : 'ta_data',
      })) }) };
}

test('mã TA cũ chỉ được chuyển cho Substitute 2 K56 Task 1', () => {
  const result = provenPizzaTask1Result();
  assert.throws(() => normalizeWebSubstituteGradingResult({
    testSlug: 'substitute-test-1-k56', taskNumber: 1, result,
  }), error => error.code === 'TEST_RESULT_COMPONENTS_INCOMPLETE');
  assert.deepEqual(normalizeWebSubstituteGradingResult({
    testSlug: 'substitute-test-2-k56', taskNumber: 1, result: task1Result(),
  }).criteria[0].components.map(item => item.code),
  ['ta_key_features_overview', 'ta_data_support']);
});

// Dữ liệu vào: mã khía cạnh từ bộ chấm pizza đã được kiểm bằng bài giả.
// Việc chính: nhận đúng hai bí danh cũ, nhưng vẫn tính điểm và lưu mã chuẩn.
// Kết quả: callback lặp không tạo thêm bài; kết quả đọc lại có mã chuẩn.
// Khi lỗi: mã lạ hoặc trùng không được ghi vào bài của học viên.
test('callback nhận mã Task 1 từ bộ chấm pizza cũ và chuẩn hóa trước khi lưu', async () => {
  const { db, intake, queue } = await fixture();
  try {
    const attempt = await intake.openAttempt(identity);
    await intake.submitWriting({ ...identity, attemptId: attempt.attemptId,
      essay: 'Synthetic answer using proven pizza codes.' });
    const [job] = await queue.claimDue();
    const result = provenPizzaTask1Result();
    const input = { ...job, result };
    for (const codes of [
      ['ta_overview', 'ta_overview'],
      ['ta_overview', 'ta_unknown'],
      ['ta_overview', 'ta_data_support'],
    ]) {
      const invalid = structuredClone(result);
      invalid.criteria[0].components.forEach((component, index) => {
        component.code = codes[index];
      });
      await assert.rejects(queue.completeWork({ ...job, result: invalid }),
        error => error.code === 'TEST_RESULT_COMPONENTS_INCOMPLETE');
    }
    const completed = await queue.completeWork(input);
    assert.equal(completed.taskScore, 6.5);
    assert.deepEqual(await queue.completeWork(input), completed);
    assert.deepEqual(result.criteria[0].components.map(item => item.code),
      ['ta_overview', 'ta_data']);
    const status = await intake.getStatus({ ...identity,
      attemptId: attempt.attemptId });
    assert.deepEqual(status.result.criteria[0].components.map(item => item.code),
      ['ta_key_features_overview', 'ta_data_support']);
  } finally {
    await db.close();
  }
});

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

test('lỗi chắc chắn thử lại có hạn; lỗi không rõ không tự chấm trùng', async () => {
  const { db, intake, queue } = await fixture();
  try {
    const attempt = await intake.openAttempt(identity);
    await intake.submitWriting({ ...identity, attemptId: attempt.attemptId,
      essay: 'Synthetic answer for retry policy.' });
    const [first] = await queue.claimDue();
    const firstFailure = await queue.reportFailure({ ...first,
      errorCode: 'WEB_GRADER_RATE_LIMITED', definiteFailure: true });
    assert.equal(firstFailure.status, 'pending');
    assert.ok(firstFailure.nextAttemptAt);
    await assert.rejects(queue.completeWork({ ...first, result: task1Result() }),
      error => error.code === 'WEB_WORK_LEASE_STALE');
    await db.query(`UPDATE writing_flow.web_substitute_submission
      SET next_attempt_at=now()-interval '1 minute'
      WHERE submission_id=$1`, [first.submissionId]);
    const [second] = await queue.claimDue();
    assert.equal(second.runKey, first.runKey);
    assert.notEqual(second.leaseToken, first.leaseToken);
    assert.equal(second.attemptNumber, 2);
    const unknown = await queue.reportFailure({ ...second,
      errorCode: 'WEB_GRADER_RESULT_UNKNOWN', definiteFailure: false });
    assert.equal(unknown.status, 'needs_review');
    assert.equal(unknown.nextAttemptAt, null);
    assert.deepEqual(await queue.claimDue(), []);
    assert.equal((await intake.getStatus({ ...identity,
      attemptId: attempt.attemptId })).submissionStatus, 'needs_review');
  } finally {
    await db.close();
  }
});

test('lần lỗi chắc chắn thứ ba dừng Cần kiểm tra', async () => {
  const { db, intake, queue } = await fixture();
  try {
    const attempt = await intake.openAttempt(identity);
    await intake.submitWriting({ ...identity, attemptId: attempt.attemptId,
      essay: 'Synthetic answer for retry ceiling.' });
    for (let i = 1; i <= 3; i += 1) {
      const [job] = await queue.claimDue();
      assert.equal(job.attemptNumber, i);
      const failure = await queue.reportFailure({ ...job,
        errorCode: 'WEB_GRADER_PRECHECK_FAILED', definiteFailure: true });
      assert.equal(failure.status, i < 3 ? 'pending' : 'needs_review');
      if (i < 3) await db.query(`UPDATE writing_flow.web_substitute_submission
        SET next_attempt_at=now()-interval '1 minute'
        WHERE submission_id=$1`, [job.submissionId]);
    }
    assert.deepEqual(await queue.claimDue(), []);
  } finally {
    await db.close();
  }
});

test('hai lượt lấy việc xen kẽ không vượt bốn bài web đang chấm', async () => {
  const { db, intake, queue } = await fixture();
  try {
    await db.exec(`RESET ROLE;
      INSERT INTO assessment_k56.term_test_roster VALUES
      ('term-test-1-k56',1252,1002,'22222222-2222-4222-8222-222222222222','Học viên Hai',true),
      ('term-test-1-k56',1252,1003,'33333333-3333-4333-8333-333333333333','Học viên Ba',true),
      ('term-test-1-k56',1252,1004,'44444444-4444-4444-8444-444444444444','Học viên Bốn',true),
      ('term-test-1-k56',1252,1005,'55555555-5555-4555-8555-555555555555','Học viên Năm',true);
      SET ROLE writing_practice_api;`);
    for (const name of ['Học viên thử', 'Học viên Hai', 'Học viên Ba',
      'Học viên Bốn', 'Học viên Năm']) {
      const selected = { ...identity, studentName: name };
      const attempt = await intake.openAttempt(selected);
      await intake.submitWriting({ ...selected, attemptId: attempt.attemptId,
        essay: `Synthetic answer for ${name}.` });
    }
    const first = await queue.claimDue({ limit: 3 });
    const second = await queue.claimDue({ limit: 3 });
    assert.equal(first.length, 3);
    assert.equal(second.length, 1);
    assert.equal(new Set([...first, ...second].map(job => job.submissionId)).size, 4);
    assert.deepEqual(await queue.claimDue({ limit: 3 }), []);
    await queue.completeWork({ ...first[0], result: task1Result() });
    const last = await queue.claimDue({ limit: 3 });
    assert.equal(last.length, 1);
    assert.equal(new Set([...first, ...second, ...last].map(job => job.submissionId)).size, 5);
  } finally {
    await db.close();
  }
});

test('một bài mã hóa hỏng vào Cần kiểm tra, bài hợp lệ phía sau vẫn được lấy', async () => {
  const { db, intake, queue } = await fixture();
  try {
    await db.exec(`RESET ROLE; INSERT INTO assessment_k56.term_test_roster VALUES
      ('term-test-1-k56',1252,1002,
       '22222222-2222-4222-8222-222222222222','Học viên Hai',true);
      SET ROLE writing_practice_api;`);
    const first = await intake.openAttempt(identity);
    const corrupt = await intake.submitWriting({ ...identity,
      attemptId: first.attemptId, essay: 'Synthetic first answer.' });
    const secondIdentity = { ...identity, studentName: 'Học viên Hai' };
    const second = await intake.openAttempt(secondIdentity);
    const healthy = await intake.submitWriting({ ...secondIdentity,
      attemptId: second.attemptId, essay: 'Synthetic second answer.' });
    await db.query(`UPDATE writing_flow.web_substitute_submission
      SET next_attempt_at=now()-interval '1 minute'
      WHERE submission_id=$1`, [corrupt.submissionId]);
    await db.exec(`RESET ROLE;`);
    await db.query(`UPDATE writing_flow.web_substitute_submission
      SET content_ciphertext=decode('abcd','hex')
      WHERE submission_id=$1`, [corrupt.submissionId]);
    await db.exec('SET ROLE writing_practice_api;');
    const jobs = await queue.claimDue({ limit: 2 });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].submissionId, healthy.submissionId);
    const states = await db.query(`SELECT submission_id,status,last_error_code
      FROM writing_flow.web_substitute_submission`);
    const bad = states.rows.find(row => row.submission_id === corrupt.submissionId);
    assert.equal(bad.status, 'needs_review');
    assert.equal(bad.last_error_code, 'WEB_WORK_VALIDATION_FAILED');
  } finally {
    await db.close();
  }
});
