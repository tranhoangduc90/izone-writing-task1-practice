-- Dữ liệu nhận vào: schema Writing Practice đã có bảng lịch sử thao tác giảng viên.
-- Việc chính: cho phép ghi nhận thao tác xếp lại đúng lượt chấm bị lỗi kỹ thuật.
-- Kết quả: giảng viên có thể khôi phục cùng Comment; không tạo lượt mới và không tăng chuỗi chưa đạt.
-- Khi lỗi: transaction rollback toàn bộ, API cũ vẫn tiếp tục hoạt động.
BEGIN;

ALTER TABLE writing_practice.admin_audit_event
  DROP CONSTRAINT IF EXISTS admin_audit_event_action_check;
ALTER TABLE writing_practice.admin_audit_event
  ADD CONSTRAINT admin_audit_event_action_check
  CHECK (action IN ('reopen_section', 'retry_failed_attempt')) NOT VALID;
ALTER TABLE writing_practice.admin_audit_event
  VALIDATE CONSTRAINT admin_audit_event_action_check;

COMMIT;
