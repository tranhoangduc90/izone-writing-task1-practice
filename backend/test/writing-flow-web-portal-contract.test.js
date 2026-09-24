import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSubstitutePortalRequest } from '../src/writing-flow-web-portal-contract.js';

const completed = {
  submissionId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  testSlug: 'substitute-test-2-k56', classId: 1252, erpStudentId: 1001,
  taskNumber: 1, submissionStatus: 'completed',
  sectionResults: { listening: { band: 6.5 }, reading: { band: 7 } },
  taskScore: 7.5,
};

test('chỉ dựng ba điểm Portal Thi lại từ phiếu hoàn tất đúng IC2264', () => {
  const preview = buildSubstitutePortalRequest(completed);
  assert.deepEqual(preview, {
    version: 1, testSlug: 'substitute-test-2-k56', classCode: 'IC2264',
    classId: 1252, studentId: 1001,
    attemptToken: completed.attemptId,
    grades: { listening: 6.5, reading: 7, writing: 7.5 }, commit: false,
  });
  assert.equal(buildSubstitutePortalRequest(completed, { commit: true }).commit, true);
});

test('chặn sai nguồn, lớp, học viên, Task hoặc lượt trước khi gọi Portal', () => {
  for (const patch of [
    { testSlug: 'substitute-test-1-k56' }, { testSlug: 'substitute-test-2-k67' },
    { classId: 1253 }, { classId: '1252' }, { classCode: 'IC2322' },
    { erpStudentId: 0 }, { taskNumber: 2 },
    { attemptId: 'browser-generated' }, { submissionStatus: 'running' },
  ]) {
    assert.throws(() => buildSubstitutePortalRequest({ ...completed, ...patch }));
  }
});

test('chặn điểm thiếu, quá biên hoặc không theo thang 0,1', () => {
  for (const patch of [
    { sectionResults: { listening: {}, reading: { band: 7 } } },
    { sectionResults: { listening: { band: 6.5 }, reading: { band: 9.5 } } },
    { sectionResults: { listening: { band: 6.55 }, reading: { band: 7 } } },
    { taskScore: null }, { taskScore: 7.25 },
  ]) {
    assert.throws(() => buildSubstitutePortalRequest({ ...completed, ...patch }));
  }
});

test('không mặc định ghi thật nếu tham số commit bị truyền sai kiểu', () => {
  assert.throws(() => buildSubstitutePortalRequest(completed, { commit: 'true' }));
  assert.throws(() => buildSubstitutePortalRequest(completed, { commit: 1 }));
});
