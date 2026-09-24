import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSubstitutePortalRequest } from '../src/writing-flow-web-portal-contract.js';

const completed = {
  submissionId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  testSlug: 'substitute-test-2-k56', classId: 1252, erpStudentId: 1001,
  taskNumber: 1, submissionStatus: 'completed',
  sectionResults: {
    listening: { correct: 30, total: 40, band: 6.5 },
    reading: { correct: 32, total: 40, band: 7 },
  },
  taskScore: 7.5,
};

test('chỉ dựng ba điểm Portal Thi lại từ phiếu hoàn tất đúng IC2264', () => {
  const preview = buildSubstitutePortalRequest(completed);
  assert.deepEqual(preview, {
    version: 1, testSlug: 'substitute-test-2-k56', classCode: 'IC2264',
    classId: 1252, studentId: 1001,
    attemptToken: completed.attemptId,
    grades: { listening: 30, reading: 32, writing: 7.5 }, commit: false,
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

test('chặn số câu thô thiếu/sai thang và Writing sai bước 0,1', () => {
  for (const patch of [
    { sectionResults: { listening: {}, reading: { correct: 32, total: 40 } } },
    { sectionResults: { listening: { correct: 40.5, total: 40 }, reading: { correct: 32, total: 40 } } },
    { sectionResults: { listening: { correct: 30, total: 39 }, reading: { correct: 32, total: 40 } } },
    { sectionResults: { listening: { correct: 30, total: 40 }, reading: { correct: 41, total: 40 } } },
    { taskScore: null }, { taskScore: 7.25 },
  ]) {
    assert.throws(() => buildSubstitutePortalRequest({ ...completed, ...patch }));
  }
});

test('band chỉ để hiển thị: đổi band không được đổi điểm thô gửi Portal', () => {
  const changed = { ...completed, sectionResults: {
    listening: { ...completed.sectionResults.listening, band: 5 },
    reading: { ...completed.sectionResults.reading, band: 8 },
  } };
  assert.deepEqual(buildSubstitutePortalRequest(changed).grades,
    { listening: 30, reading: 32, writing: 7.5 });
});

test('không mặc định ghi thật nếu tham số commit bị truyền sai kiểu', () => {
  assert.throws(() => buildSubstitutePortalRequest(completed, { commit: 'true' }));
  assert.throws(() => buildSubstitutePortalRequest(completed, { commit: 1 }));
});
