// Dữ liệu nhận vào: bí danh bảng lớp và vị trí tham số email trong câu SQL nội bộ.
// Việc chính: chấp nhận quyền lớp đã materialize hoặc phân công còn hiệu lực từ bảng xuất Lark.
// Kết quả: dashboard, bài chi tiết và phần chấm từng câu dùng cùng một cổng phân quyền.
// Khi dữ liệu nguồn thiếu/hết hiệu lực: điều kiện trả false, không mở rộng quyền ngoài lớp được giao.
export function reviewerClassAccessSql(scopeAlias, reviewerParam) {
  if (!/^[a-z_][a-z0-9_]*$/u.test(scopeAlias) || !/^\$\d+$/u.test(reviewerParam)) {
    throw new TypeError('Tham số SQL phân quyền lớp không hợp lệ.');
  }
  return `(EXISTS (
    SELECT 1 FROM mapping.reviewer_class_access access
    WHERE access.reviewer_email=${reviewerParam}
      AND access.erp_course_class_id=${scopeAlias}.erp_course_class_id
  ) OR EXISTS (
    SELECT 1 FROM mapping.lark_export_teacher_assignments assignment
    WHERE lower(trim(assignment.payload->>'Email tài khoản'))=lower(${reviewerParam})
      AND ${scopeAlias}.erp_course_class_id=ANY(assignment.scope_class_ids)
      AND lower(trim(assignment.payload->>'Trạng thái tài khoản'))='active'
      AND assignment.source_status='Đang có trong nguồn'
  ))`;
}
