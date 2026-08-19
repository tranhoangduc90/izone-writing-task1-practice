// Dữ liệu nhận vào: kết quả PostgreSQL giả có một lớp và một học viên công khai.
// Việc chính: đảm bảo service đọc mảng `rows` bên trong kết quả truy vấn.
// Kết quả: roster trả đúng cấu trúc; lỗi “rows is not iterable” sẽ làm test thất bại.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingPracticeService } from '../src/service.js';

function transactionalPool(responses, queries) {
  const client = {
    query: async (sql) => {
      queries.push(String(sql));
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      const next = responses.shift();
      if (!next) throw new Error(`Thiếu response giả cho SQL: ${String(sql).slice(0, 80)}`);
      return next;
    },
    release() {}
  };
  return { connect: async () => client };
}

test('roster iterates PostgreSQL result rows', async () => {
  const responses = [
    { rowCount: 1, rows: [{ id: 7, slug: 'task-1', title: 'Task 1' }] },
    {
      rowCount: 1,
      rows: [{
        class_ref: '00000000-0000-4000-8000-000000000001',
        class_name_snapshot: 'Lớp thử nghiệm',
        student_ref: '00000000-0000-4000-8000-000000000002',
        display_name: 'Học viên thử nghiệm',
        display_alias: 'Học viên thử nghiệm'
      }]
    }
  ];
  const pool = { query: async () => responses.shift() };
  const result = await createWritingPracticeService({ pool }).getRoster('task-1');

  assert.equal(result.classes.length, 1);
  assert.equal(result.classes[0].students.length, 1);
});

test('Task 1 session route cannot open a non-Task-1 grading pool', async () => {
  const queries = [];
  const pool = transactionalPool([{ rowCount: 0, rows: [] }], queries);
  await assert.rejects(
    createWritingPracticeService({ pool }).openSession({ activitySlug: 'lesson-activity', classRef: 'class-ref', studentRef: 'student-ref' }),
    error => error.code === 'SESSION_NOT_ALLOWED'
  );
  assert.equal(queries.some(sql => sql.includes("a.grading_pool='task1'")), true);
});

test('Draft Check is rejected until Overview and Outline have both passed', async () => {
  const queries = [];
  const pool = transactionalPool([
    { rowCount: 1, rows: [{ id: 'session-id', draft1: 'D1', draft2: 'D2', draft2_unlocked: true }] },
    { rowCount: 1, rows: [] },
    { rowCount: 2, rows: [{ section_key: 'overview', locked: true }, { section_key: 'outline', locked: false }] }
  ], queries);
  const service = createWritingPracticeService({ pool });
  await assert.rejects(
    service.submitCheck({ sessionRef: 'session-ref', section: 'draft', requestId: 'request-ref', snapshot: { overview: 'O', body1: 'B1', body2: 'B2', draft1: 'D1', draft2: 'D2' } }),
    error => error.code === 'DRAFT_PREREQUISITES_NOT_PASSED'
  );
  assert.equal(queries.some(sql => sql.includes('INSERT INTO writing_practice.check_attempt')), false);
});

test('Draft Check cannot grade text newer than the latest saved database version', async () => {
  const queries = [];
  const pool = transactionalPool([
    { rowCount: 1, rows: [{ id: 'session-id', draft1: 'Saved D1', draft2: 'Saved D2', draft2_unlocked: true }] },
    { rowCount: 1, rows: [] },
    { rowCount: 2, rows: [{ section_key: 'overview', locked: true }, { section_key: 'outline', locked: true }] }
  ], queries);
  const service = createWritingPracticeService({ pool });
  await assert.rejects(
    service.submitCheck({ sessionRef: 'session-ref', section: 'draft', requestId: 'request-ref', snapshot: { overview: 'O', body1: 'B1', body2: 'B2', draft1: 'Saved D1', draft2: 'Unsaved D2' } }),
    error => error.code === 'DRAFT_NOT_SAVED'
  );
  assert.equal(queries.some(sql => sql.includes('INSERT INTO writing_practice.check_attempt')), false);
});

test('Draft jobs receive a longer lease while claim keeps row locking without a global four-job cap', async () => {
  const queries = [];
  const pool = transactionalPool([{ rowCount: 0, rows: [] }], queries);
  const jobs = await createWritingPracticeService({ pool }).claimJobs({ workerId: 'test', maxJobs: 40, leaseSeconds: 420 });

  assert.deepEqual(jobs, []);
  assert.equal(queries.some(sql => sql.includes("section_key='draft' THEN 1200")), true);
  assert.equal(queries.some(sql => sql.includes("GREATEST(0,4-count(*))")), false);
  assert.equal(queries.some(sql => sql.includes('writing_practice:grading_capacity')), false);
  assert.equal(queries.some(sql => sql.includes('FOR UPDATE OF attempt SKIP LOCKED')), true);
  assert.equal(queries.some(sql => sql.includes('LIMIT $1::int')), true);
});

test('Task 2 Draft job receives vocabulary artifacts from the passed Idea 2 check', async () => {
  const queries = [];
  const vocabulary = [{ idea: 'ý thử nghiệm', terms: ['test term'] }];
  const pool = transactionalPool([
    { rowCount: 1, rows: [{ id: 3, public_id: 'job-ref', section_key: 'draft', comment_number: 1, snapshot: { draft1: 'D1', draft2: 'D2' }, lease_token: 'lease-ref', lease_expires_at: '2026-08-19T00:00:00Z', session_id: 7 }] },
    { rowCount: 1, rows: [{ task_prompt: 'Đề thử nghiệm', prompt_registry_key: 'registry', prompt_record_ref: 'record', prompt_version: 'v1', history: [] }] },
    { rowCount: 1, rows: [{ artifacts: { supporting_idea_2: { vocabulary } } }] },
  ], queries);
  const [job] = await createWritingPracticeService({ pool }).claimJobs({ workerId: 'task2-test', workerPool: 'task2', maxJobs: 1, leaseSeconds: 420 });
  assert.deepEqual(job.contextArtifacts.supporting_idea_2.vocabulary, vocabulary);
  assert.equal(queries.some(sql => sql.includes("result_artifacts<>'{}'::jsonb")), true);
});

test('Draft completion requires an official LMS link and then locks the section', async () => {
  const queries = [];
  const pool = transactionalPool([
    { rowCount: 1, rows: [{ id: 'attempt-id', session_id: 'session-id', section_key: 'draft', version: 3 }] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [] },
    { rowCount: 1, rows: [{ fail_streak: 0 }] }
  ], queries);
  const service = createWritingPracticeService({ pool });
  const result = await service.completeJob({
    jobRef: 'job-ref',
    leaseToken: 'lease-ref',
    resultStatus: 'passed',
    feedback: 'Đã có kết quả.',
    artifacts: { lmsUrl: 'https://practice.izone.edu.vn/shared/writing-essays/example/edit?page=0' }
  });
  assert.equal(result.resultStatus, 'passed');
  assert.equal(queries.some(sql => sql.includes('SET locked=true')), true);
});

test('Draft completion rejects a forged LMS host before writing to PostgreSQL', async () => {
  let connected = false;
  const pool = { connect: async () => { connected = true; throw new Error('Không được kết nối'); } };
  const service = createWritingPracticeService({ pool });
  await assert.rejects(
    service.completeJob({ jobRef: 'job-ref', leaseToken: 'lease-ref', resultStatus: 'passed', feedback: 'X', artifacts: { lmsUrl: 'https://practice.izone.edu.vn.evil.example/result' } }),
    error => error.code === 'INVALID_LMS_URL'
  );
  assert.equal(connected, false);
});

test('Draft completion rejects an unrelated path on the official LMS host', async () => {
  let connected = false;
  const pool = { connect: async () => { connected = true; throw new Error('Không được kết nối'); } };
  const service = createWritingPracticeService({ pool });
  await assert.rejects(
    service.completeJob({ jobRef: 'job-ref', leaseToken: 'lease-ref', resultStatus: 'passed', feedback: 'X', artifacts: { lmsUrl: 'https://practice.izone.edu.vn/unrelated-page' } }),
    error => error.code === 'INVALID_LMS_URL'
  );
  assert.equal(connected, false);
});
