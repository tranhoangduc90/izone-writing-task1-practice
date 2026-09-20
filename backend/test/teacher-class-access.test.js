import assert from 'node:assert/strict';
import test from 'node:test';

import { createTeacherClassAccessService, reviewerIsAdmin } from '../src/teacher-class-access.js';

const teacher = { email: 'teacher@example.invalid', role: 'teacher' };
const admin = { email: 'admin@example.invalid', role: 'admin' };
const ref = '11111111-1111-4111-8111-111111111111';

test('chỉ role admin được bỏ qua giới hạn lớp', () => {
  assert.equal(reviewerIsAdmin(admin), true);
  assert.equal(reviewerIsAdmin({ ...teacher, canAccessAllClasses: true }), false);
});

test('danh sách lớp của giảng viên được ghép bằng ID lớp ổn định', async () => {
  let call;
  const pool = { query: async (sql, params) => {
    call = { sql, params };
    return { rows: [{ classCode: 'CS.TEST' }] };
  } };
  const service = createTeacherClassAccessService({ pool });
  assert.deepEqual(await service.listClasses(teacher), [{ classCode: 'CS.TEST' }]);
  assert.match(call.sql, /access\.erp_course_class_id=scope\.erp_course_class_id/u);
  assert.match(call.sql, /mapping\.lark_export_teacher_assignments/u);
  assert.match(call.sql, /scope\.erp_course_class_id=ANY\(assignment\.scope_class_ids\)/u);
  assert.deepEqual(call.params, [false, teacher.email]);
});

test('mọi đường mở lớp, bài, lượt chấm, học viên tạm và comment dùng cùng quyền Lark dự phòng', async () => {
  const calls = [];
  const pool = { query: async (sql, params) => {
    calls.push({ sql, params });
    return { rowCount: 1, rows: [{ ok: 1 }] };
  } };
  const service = createTeacherClassAccessService({ pool });
  await service.assertActivityClass(teacher, { activitySlug: 'writing-task2-test', classRef: ref });
  await service.assertSession(teacher, ref);
  await service.assertAttempt(teacher, ref);
  await service.assertProvisionalStudent(teacher, ref);
  await service.assertCommentThread(teacher, ref);
  assert.equal(calls.length, 5);
  for (const call of calls) {
    assert.match(call.sql, /mapping\.reviewer_class_access/u);
    assert.match(call.sql, /mapping\.lark_export_teacher_assignments/u);
    assert.match(call.sql, /Trạng thái tài khoản/u);
    assert.equal(call.params[0], ref);
    assert.equal(call.params[1], teacher.email);
  }
  assert.deepEqual(calls[0].params, [ref, teacher.email, 'writing-task2-test']);
});

test('giảng viên bị chặn khi session không thuộc lớp được phân công', async () => {
  const pool = { query: async () => ({ rowCount: 0, rows: [] }) };
  const service = createTeacherClassAccessService({ pool });
  await assert.rejects(() => service.assertSession(teacher, ref), error => {
    assert.equal(error.status, 403);
    assert.equal(error.code, 'CLASS_ACCESS_DENIED');
    return true;
  });
});

test('admin mở session không cần bản ghi phân công lớp', async () => {
  let calls = 0;
  const pool = { query: async () => { calls += 1; return { rowCount: 0, rows: [] }; } };
  const service = createTeacherClassAccessService({ pool });
  await service.assertSession(admin, ref);
  assert.equal(calls, 0);
});
