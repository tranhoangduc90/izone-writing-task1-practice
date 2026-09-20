import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvisionalStudentService, normalizeStudentName } from '../src/provisional-service.js';

test('chuẩn hóa tên loại ký tự vô hình/control và thu gọn khoảng trắng', () => {
  assert.equal(normalizeStudentName('  Nguyễn\u200b   Văn\u0007  An  '), 'Nguyễn Văn An');
});

test('API không khởi động chức năng mã tạm nếu pepper yếu', () => {
  assert.throws(() => createProvisionalStudentService({ pool: {}, pepper: 'ngắn' }), /32 ký tự/);
});

test('danh sách học viên tạm dùng cùng quyền Lark dự phòng với dashboard chính', async () => {
  let receivedSql = '';
  const pool = { query: async (sql, params) => {
    receivedSql = sql;
    assert.deepEqual(params, ['writing-task2-test', null, false, 'teacher@example.invalid']);
    return { rows: [] };
  } };
  const service = createProvisionalStudentService({ pool, pepper: 'p'.repeat(32) });
  assert.deepEqual(await service.listPending({
    activitySlug: 'writing-task2-test',
    reviewerEmail: 'teacher@example.invalid',
    canAccessAllClasses: false,
  }), []);
  assert.match(receivedSql, /mapping\.reviewer_class_access/u);
  assert.match(receivedSql, /mapping\.lark_export_teacher_assignments/u);
  assert.match(receivedSql, /scope\.erp_course_class_id=ANY\(assignment\.scope_class_ids\)/u);
});

function transactionPool(queryHandler) {
  return {
    connect: async () => ({
      query: async (sql, params = []) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql) ? { rowCount: 0, rows: [] } : queryHandler(sql, params),
      release() {}
    })
  };
}

test('tìm hồ sơ chính thức dùng hàm database toàn cục và chỉ trả UUID công khai', async () => {
  const officialRef = '22222222-2222-4222-8222-222222222222';
  const pool = { query: async (sql, params) => {
    assert.match(sql, /search_official_students/);
    assert.match(sql, /\$1::text,\$2::uuid,\$3::integer/);
    assert.deepEqual(params, ['Học viên giả', null, 20]);
    return { rows: [{ studentRef: officialRef, displayName: 'Học viên giả', classNames: ['Lớp B'] }] };
  } };
  const service = createProvisionalStudentService({ pool, pepper: 'p'.repeat(32) });
  const result = await service.searchOfficialStudents({ query: '  Học viên giả  ' });
  assert.deepEqual(result, [{ studentRef: officialRef, displayName: 'Học viên giả', classNames: ['Lớp B'] }]);
});

test('ghép hồ sơ khác lớp bằng UUID và tạo ngoại lệ roster bền vững', async () => {
  const provisionalRef = '11111111-1111-4111-8111-111111111111';
  const officialRef = '22222222-2222-4222-8222-222222222222';
  const writes = [];
  const pool = transactionPool(async (sql, params) => {
    if (/FROM writing_practice\.provisional_student provisional/u.test(sql) && /FOR UPDATE/u.test(sql)) return { rowCount: 1, rows: [{ activity_class_id: 5, status: 'pending', activity_id: 7 }] };
    if (/resolve_official_student/u.test(sql)) return { rowCount: 1, rows: [{ erp_student_contact_id: 99, student_public_id: officialRef, display_name: 'Học viên giả' }] };
    if (/SELECT 1 FROM writing_practice\.activity_student_alias/u.test(sql)) return { rowCount: 0, rows: [] };
    if (/SELECT 1 FROM writing_practice\.activity_session/u.test(sql)) return { rowCount: 0, rows: [] };
    writes.push({ sql, params }); return { rowCount: 1, rows: [] };
  });
  const service = createProvisionalStudentService({ pool, pepper: 'p'.repeat(32) });
  const result = await service.reconcile({ studentRef: provisionalRef, officialStudentRef: officialRef, actorRef: 'teacher@example.invalid' });
  assert.equal(result.reconciliationStatus, 'matched');
  const override = writes.find(item => /INSERT INTO writing_practice\.activity_roster_override/u.test(item.sql));
  assert.deepEqual(override.params.slice(0, 4), [5, 99, officialRef, 'Học viên giả']);
  const alias = writes.find(item => /INSERT INTO writing_practice\.activity_student_alias/u.test(item.sql));
  assert.deepEqual(alias.params.slice(0, 3), [5, officialRef, provisionalRef]);
  // Cùng tên vẫn ghép được: tắt đúng hồ sơ tạm trước khi bật hồ sơ chính thức.
  const deactivateIndex = writes.findIndex(item => /UPDATE writing_practice\.activity_roster SET active=false/u.test(item.sql));
  const activateIndex = writes.findIndex(item => /INSERT INTO writing_practice\.activity_roster\s*\(/u.test(item.sql));
  assert.ok(deactivateIndex >= 0 && deactivateIndex < activateIndex);
  assert.deepEqual(writes[deactivateIndex].params, [5, provisionalRef]);
  assert.match(writes[deactivateIndex].sql, /WHERE activity_class_id=\$1 AND student_public_id=\$2/u);
  assert.equal(writes.some(item => /(?:UPDATE|DELETE FROM) writing_practice\.activity_session/u.test(item.sql)), false);
});

test('xóa mềm chỉ đổi đúng hồ sơ tạm và giữ lịch sử bài làm', async () => {
  const provisionalRef = '11111111-1111-4111-8111-111111111111';
  const writes = [];
  const pool = transactionPool(async (sql, params) => {
    if (/FROM writing_practice\.provisional_student/u.test(sql) && /FOR UPDATE/u.test(sql)) return { rowCount: 1, rows: [{ activity_class_id: 5, status: 'pending' }] };
    writes.push({ sql, params }); return { rowCount: 1, rows: [] };
  });
  const service = createProvisionalStudentService({ pool, pepper: 'p'.repeat(32) });
  const result = await service.deleteStudent({ studentRef: provisionalRef, actorRef: 'teacher@example.invalid' });
  assert.equal(result.reconciliationStatus, 'deleted');
  assert.equal(writes.some(item => /DELETE FROM/u.test(item.sql)), false);
  const rosterWrite = writes.find(item => /UPDATE writing_practice\.activity_roster/u.test(item.sql));
  assert.deepEqual(rosterWrite.params, [5, provisionalRef]);
  assert.match(writes.find(item => /provisional_student_audit/u.test(item.sql)).sql, /historyPreserved/u);
});
