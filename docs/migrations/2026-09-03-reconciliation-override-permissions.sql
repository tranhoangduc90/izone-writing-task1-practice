-- Dữ liệu nhận vào: vai trò API Writing đã tồn tại và bảng ngoại lệ danh sách lớp.
-- Việc chính: cấp đúng các cột mà thao tác ghép hồ sơ cần đọc, thêm và cập nhật.
-- Kết quả: ghép khác lớp lưu được liên kết; không cấp DELETE hoặc quyền đọc bảng mapping.
-- Khi lỗi: toàn bộ thay đổi quyền rollback; xem lỗi PostgreSQL trước khi phát hành.
BEGIN;

GRANT SELECT (
  activity_class_id, erp_student_contact_id, student_public_id,
  display_name, active, approved_by, reason, updated_at
), INSERT (
  activity_class_id, erp_student_contact_id, student_public_id,
  display_name, active, approved_by, reason
), UPDATE (
  student_public_id, display_name, active, approved_by, reason, updated_at
)
ON writing_practice.activity_roster_override TO writing_practice_api;

COMMIT;
