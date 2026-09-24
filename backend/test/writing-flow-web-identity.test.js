import assert from 'node:assert/strict';
import test from 'node:test';
import { bindWebSubstituteAttempt, findNamedRosterStudent, WEB_SUBSTITUTE_PROFILES }
  from '../src/writing-flow-web-identity.js';

const stored = Object.freeze({
  source: 'substitute_web', cohort: 56, classId: 1252,
  erpStudentId: 1001,
  testSlug: 'substitute-test-2-k56',
  attemptId: '22222222-2222-4222-8222-222222222222',
  taskNumber: 1, rubricVersion: 'substitute-2-k56-v1',
  runKey: 'run-opaque-1',
});
const roster = Object.freeze({
  classId: 1252, erpStudentId: stored.erpStudentId, eligible: true,
});
const request = Object.freeze({
  classId: stored.classId, erpStudentId: stored.erpStudentId,
  testSlug: stored.testSlug, attemptId: stored.attemptId,
  taskNumber: stored.taskNumber, rubricVersion: stored.rubricVersion,
  runKey: stored.runKey,
});

test('bốn trang Substitute ghim đúng cohort và Task từ Pages', () => {
  assert.deepEqual(Object.entries(WEB_SUBSTITUTE_PROFILES).map(([slug, profile]) =>
    [slug, profile.cohort, [...profile.tasks]]), [
    ['substitute-test-1-k56', 56, [2]],
    ['substitute-test-2-k56', 56, [1]],
    ['substitute-test-1-k67', 67, [2]],
    ['substitute-test-2-k67', 67, [2]],
  ]);
});

test('chỉ phiếu backend trùng roster và đủ khóa mới được xử lý', () => {
  assert.deepEqual(bindWebSubstituteAttempt({ stored, roster, request }), {
    source: 'substitute_web', cohort: 56, classId: 1252,
    erpStudentId: stored.erpStudentId, testSlug: stored.testSlug,
    attemptId: stored.attemptId, taskNumber: 1,
    rubricVersion: stored.rubricVersion, runKey: stored.runKey,
  });
});

for (const [name, mutation] of Object.entries({
  'mã lượt do trình duyệt tự chế': { request: { attemptId: '33333333-3333-4333-8333-333333333333' } },
  'lớp khác': { request: { classId: 9999 } },
  'học viên khác': { request: { erpStudentId: 1002 } },
  'đề khác': { request: { testSlug: 'substitute-test-1-k56' } },
  'Task khác': { request: { taskNumber: 2 } },
  'rubric khác': { request: { rubricVersion: 'other' } },
  'run khác': { request: { runKey: 'other' } },
  'roster sai lớp': { roster: { classId: 9999 } },
  'roster sai học viên': { roster: { erpStudentId: 1002 } },
  'roster không đủ điều kiện': { roster: { eligible: false } },
  'nguồn không phải web': { stored: { source: 'term_test' } },
  'cohort không khớp': { stored: { cohort: 67 } },
})) {
  test(`từ chối ${name} trước khi ghi hoặc trả kết quả`, () => {
    assert.throws(() => bindWebSubstituteAttempt({
      stored: { ...stored, ...mutation.stored },
      roster: { ...roster, ...mutation.roster },
      request: { ...request, ...mutation.request },
    }), error => error.code === 'WEB_ATTEMPT_IDENTITY_MISMATCH');
  });
}

test('không nhận Task 1 chưa có trên trang Substitute 2 K67', () => {
  const k67 = { ...stored, cohort: 67, testSlug: 'substitute-test-2-k67', taskNumber: 1 };
  assert.throws(() => bindWebSubstituteAttempt({
    stored: k67,
    roster,
    request: { ...request, testSlug: k67.testSlug },
  }), error => error.code === 'WEB_ATTEMPT_IDENTITY_MISMATCH');
});

test('thiếu phiếu server hoặc roster thì đóng thay vì hiện đang chấm', () => {
  assert.throws(() => bindWebSubstituteAttempt({ stored: null, roster, request }),
    error => error.code === 'WEB_ATTEMPT_NOT_FOUND');
  assert.throws(() => bindWebSubstituteAttempt({ stored, roster: null, request }),
    error => error.code === 'WEB_ATTEMPT_NOT_FOUND');
});

test('chọn lại cùng tên chỉ khôi phục định danh roster, không xác thực con người', () => {
  const firstDevice = bindWebSubstituteAttempt({ stored, roster, request });
  const secondDevice = bindWebSubstituteAttempt({ stored, roster, request });
  assert.deepEqual(secondDevice, firstDevice);
  // Không có bí mật học viên trong hợp đồng này: rủi ro xem hộ phải được hiển thị khi phát hành.
  assert.equal(Object.hasOwn(request, 'studentSecret'), false);
});

test('tên chọn lại trên thiết bị khác ánh xạ về đúng một mã roster trong lớp', () => {
  const rows = [
    { classId: 1252, erpStudentId: stored.erpStudentId, studentName: 'Học viên A', eligible: true },
    { classId: 1253, erpStudentId: 1002,
      studentName: 'Học viên A', eligible: true },
  ];
  assert.deepEqual(findNamedRosterStudent({
    rosterRows: rows, classId: 1252, selectedName: '  Học   viên A  ',
  }), roster);
});

test('tên trùng trong cùng lớp hoặc không đủ điều kiện phải dừng', () => {
  const rows = [
    { classId: 1252, erpStudentId: stored.erpStudentId, studentName: 'Học viên A', eligible: true },
    { classId: 1252, erpStudentId: 1002,
      studentName: 'Học viên A', eligible: true },
  ];
  assert.throws(() => findNamedRosterStudent({
    rosterRows: rows, classId: 1252, selectedName: 'Học viên A',
  }), error => error.code === 'ROSTER_NAME_AMBIGUOUS');
  assert.throws(() => findNamedRosterStudent({
    rosterRows: rows, classId: 1253, selectedName: 'Học viên A',
  }), error => error.code === 'ROSTER_NAME_NOT_FOUND');
});
