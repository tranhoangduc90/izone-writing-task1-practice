import test from 'node:test';
import assert from 'node:assert/strict';
import { groupStudents } from '../js/teacher-progress.js';

const student = (displayName, values = {}) => ({ displayName, hasStarted: true, progressPercent: 20,
  passedSectionCount: 0, attemptedSectionCount: 1, supportRequired: false, supportSections: [], ...values });

test('ưu tiên Comment 9 trước 6 trước 3 rồi mới đến tiến trình thấp', () => {
  const groups = groupStudents([
    student('Bình thường', { progressPercent: 0 }),
    student('Mốc 3', { supportRequired: true, supportSections: [{ commentNumber: 3, warningAt: '2026-01-03' }] }),
    student('Mốc 9', { supportRequired: true, supportSections: [{ commentNumber: 9, warningAt: '2026-01-01' }] }),
    student('Mốc 6', { supportRequired: true, supportSections: [{ commentNumber: 6, warningAt: '2026-01-02' }] })
  ]);
  assert.deepEqual(groups[0].students.map(item => item.displayName), ['Mốc 9', 'Mốc 6', 'Mốc 3']);
  assert.equal(groups[1].students[0].displayName, 'Bình thường');
});

test('học viên chưa làm luôn ở cuối và số section cần hỗ trợ được ưu tiên trước', () => {
  const groups = groupStudents([
    student('Chưa làm', { hasStarted: false }),
    student('Một cảnh báo', { supportRequired: true, supportSections: [{ commentNumber: 9, warningAt: '2026-01-01' }] }),
    student('Hai cảnh báo', { supportRequired: true, supportSections: [{ commentNumber: 3, warningAt: '2026-01-02' }, { commentNumber: 3, warningAt: '2026-01-03' }] })
  ]);
  assert.equal(groups[0].students[0].displayName, 'Hai cảnh báo');
  assert.equal(groups[2].students[0].displayName, 'Chưa làm');
});
