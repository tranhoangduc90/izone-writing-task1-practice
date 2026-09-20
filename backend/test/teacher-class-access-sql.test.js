import assert from 'node:assert/strict';
import test from 'node:test';

import { reviewerClassAccessSql } from '../src/teacher-class-access-sql.js';

test('cổng quyền lớp nhận cả quyền đã đồng bộ và phân công Lark đang còn hiệu lực', () => {
  const sql = reviewerClassAccessSql('scope', '$4');
  assert.match(sql, /mapping\.reviewer_class_access/u);
  assert.match(sql, /mapping\.lark_export_teacher_assignments/u);
  assert.match(sql, /access\.reviewer_email=\$4/u);
  assert.match(sql, /scope\.erp_course_class_id=ANY\(assignment\.scope_class_ids\)/u);
  assert.match(sql, /Trạng thái tài khoản/u);
  assert.match(sql, /='active'/u);
  assert.match(sql, /assignment\.source_status='Đang có trong nguồn'/u);
});

test('cổng quyền lớp không cho chèn bí danh bảng hoặc vị trí tham số tùy ý', () => {
  assert.throws(() => reviewerClassAccessSql('scope; DROP TABLE x', '$2'), TypeError);
  assert.throws(() => reviewerClassAccessSql('scope', 'teacher@example.invalid'), TypeError);
});
