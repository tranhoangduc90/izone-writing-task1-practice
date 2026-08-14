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

test('Draft Check is rejected until Overview and Outline have both passed', async () => {
  const queries = [];
  const pool = transactionalPool([
    { rowCount: 1, rows: [{ id: 'session-id', draft1: 'D1', draft2: 'D2', draft2_unlocked: true }] },
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
    { rowCount: 2, rows: [{ section_key: 'overview', locked: true }, { section_key: 'outline', locked: true }] }
  ], queries);
  const service = createWritingPracticeService({ pool });
  await assert.rejects(
    service.submitCheck({ sessionRef: 'session-ref', section: 'draft', requestId: 'request-ref', snapshot: { overview: 'O', body1: 'B1', body2: 'B2', draft1: 'Saved D1', draft2: 'Unsaved D2' } }),
    error => error.code === 'DRAFT_NOT_SAVED'
  );
  assert.equal(queries.some(sql => sql.includes('INSERT INTO writing_practice.check_attempt')), false);
});
