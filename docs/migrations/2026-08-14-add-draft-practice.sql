-- Dữ liệu nhận vào: schema Writing Practice v1 đang có Overview và Outline.
-- Việc chính: thêm nơi lưu Draft 1/Draft 2 và cho phép một timeline chấm Draft độc lập.
-- Kết quả: phiên cũ được bổ sung phần Draft nhưng toàn bộ bài làm, Comment và hàng đợi cũ được giữ nguyên.
-- Khi lỗi: transaction rollback toàn bộ; API production cũ vẫn tiếp tục dùng ba cột Overview/Body như trước.
BEGIN;

ALTER TABLE writing_practice.activity_session
  ADD COLUMN IF NOT EXISTS draft1 TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS draft2 TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS draft2_unlocked BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE writing_practice.session_section
  DROP CONSTRAINT IF EXISTS session_section_section_key_check;
ALTER TABLE writing_practice.session_section
  ADD CONSTRAINT session_section_section_key_check
  CHECK (section_key IN ('overview','outline','draft')) NOT VALID;
ALTER TABLE writing_practice.session_section
  VALIDATE CONSTRAINT session_section_section_key_check;

ALTER TABLE writing_practice.check_attempt
  DROP CONSTRAINT IF EXISTS check_attempt_section_key_check;
ALTER TABLE writing_practice.check_attempt
  ADD CONSTRAINT check_attempt_section_key_check
  CHECK (section_key IN ('overview','outline','draft')) NOT VALID;
ALTER TABLE writing_practice.check_attempt
  VALIDATE CONSTRAINT check_attempt_section_key_check;

ALTER TABLE writing_practice.comment
  DROP CONSTRAINT IF EXISTS comment_section_key_check;
ALTER TABLE writing_practice.comment
  ADD CONSTRAINT comment_section_key_check
  CHECK (section_key IN ('overview','outline','draft')) NOT VALID;
ALTER TABLE writing_practice.comment
  VALIDATE CONSTRAINT comment_section_key_check;

ALTER TABLE writing_practice.admin_audit_event
  DROP CONSTRAINT IF EXISTS admin_audit_event_section_key_check;
ALTER TABLE writing_practice.admin_audit_event
  ADD CONSTRAINT admin_audit_event_section_key_check
  CHECK (section_key IN ('overview','outline','draft')) NOT VALID;
ALTER TABLE writing_practice.admin_audit_event
  VALIDATE CONSTRAINT admin_audit_event_section_key_check;

INSERT INTO writing_practice.session_section(session_id, section_key)
SELECT id, 'draft' FROM writing_practice.activity_session
ON CONFLICT (session_id, section_key) DO NOTHING;

COMMIT;
