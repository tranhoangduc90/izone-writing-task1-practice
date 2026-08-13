// Dữ liệu nhận vào: kết quả PostgreSQL giả có một lớp và một học viên công khai.
// Việc chính: đảm bảo service đọc mảng `rows` bên trong kết quả truy vấn.
// Kết quả: roster trả đúng cấu trúc; lỗi “rows is not iterable” sẽ làm test thất bại.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingPracticeService } from '../src/service.js';

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
