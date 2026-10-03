-- Nhận vào: lỗi nguồn đã được ghi cảnh báo trong Google Docs và đọc lại đúng ô.
-- Việc chính: lưu biên nhận để dashboard tách bài đã cảnh báo khỏi bài cần xem xét.
-- Trả ra: hai nhóm lỗi nguồn có thể đếm và lọc ngay trong PostgreSQL.
-- Khi lỗi: transaction hoàn tác; không đổi trạng thái chấm hoặc tài liệu học viên.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));

ALTER TABLE writing_flow.source_issue
  ADD COLUMN IF NOT EXISTS warning_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS warning_kind text,
  ADD COLUMN IF NOT EXISTS warning_document_revision text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
    WHERE conname='source_issue_warning_receipt_check'
      AND conrelid='writing_flow.source_issue'::regclass) THEN
    ALTER TABLE writing_flow.source_issue
      ADD CONSTRAINT source_issue_warning_receipt_check
      CHECK ((warning_confirmed_at IS NULL AND warning_kind IS NULL
        AND warning_document_revision IS NULL)
        OR (warning_confirmed_at IS NOT NULL AND warning_kind IN
          ('TITLE_WRITING','VIETNAMESE_WRITING','NONSTANDARD_K56_TOPIC')
          AND nullif(warning_document_revision,'') IS NOT NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS writing_source_issue_warning_group_idx
  ON writing_flow.source_issue (warning_confirmed_at,last_seen_at DESC)
  WHERE status='open';

COMMIT;
