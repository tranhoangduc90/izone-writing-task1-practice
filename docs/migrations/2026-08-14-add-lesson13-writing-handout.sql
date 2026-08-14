-- Dữ liệu nhận vào: schema Writing Practice hiện hành đã có Overview, Outline và Draft.
-- Việc chính: thêm cấu hình section linh hoạt cho handout Lesson 13, vùng lưu câu trả lời dạng JSON
-- và tách hàng đợi chấm theo nhóm để workflow Task 1 không nhận nhầm bài Lesson 13.
-- Kết quả: luồng Task 1 cũ giữ nguyên; Lesson 13 có sáu section độc lập và có thể trả thêm bảng từ vựng.
-- Khi lỗi: toàn bộ thay đổi rollback trong một transaction, không để schema ở trạng thái dở dang.
BEGIN;

ALTER TABLE writing_practice.activity
  ADD COLUMN IF NOT EXISTS grading_pool TEXT NOT NULL DEFAULT 'task1';

ALTER TABLE writing_practice.activity
  DROP CONSTRAINT IF EXISTS activity_grading_pool_check;
ALTER TABLE writing_practice.activity
  ADD CONSTRAINT activity_grading_pool_check
  CHECK (grading_pool ~ '^[a-z0-9][a-z0-9_-]{1,49}$') NOT VALID;
ALTER TABLE writing_practice.activity
  VALIDATE CONSTRAINT activity_grading_pool_check;

ALTER TABLE writing_practice.activity_session
  ADD COLUMN IF NOT EXISTS response_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS active_field TEXT;

ALTER TABLE writing_practice.activity_session
  DROP CONSTRAINT IF EXISTS activity_session_active_field_check;
ALTER TABLE writing_practice.activity_session
  ADD CONSTRAINT activity_session_active_field_check
  CHECK (active_field IS NULL OR active_field ~ '^[a-z0-9][a-z0-9_]{1,79}$') NOT VALID;
ALTER TABLE writing_practice.activity_session VALIDATE CONSTRAINT activity_session_active_field_check;

CREATE TABLE IF NOT EXISTS writing_practice.activity_section_definition (
  activity_id BIGINT NOT NULL REFERENCES writing_practice.activity(id) ON DELETE RESTRICT,
  section_key TEXT NOT NULL CHECK (section_key ~ '^[a-z0-9][a-z0-9_]{1,79}$'),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  sort_order SMALLINT NOT NULL CHECK (sort_order > 0),
  input_fields JSONB NOT NULL CHECK (jsonb_typeof(input_fields) = 'array'),
  context_fields JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(context_fields) = 'array'),
  required_fields JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_fields) = 'array'),
  validation_mode TEXT NOT NULL DEFAULT 'all' CHECK (validation_mode IN ('all','any')),
  prompt_record_ref TEXT,
  prompt_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, section_key),
  UNIQUE (activity_id, sort_order)
);

ALTER TABLE writing_practice.check_attempt
  ADD COLUMN IF NOT EXISTS result_artifacts JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE writing_practice.session_section
  DROP CONSTRAINT IF EXISTS session_section_section_key_check;
ALTER TABLE writing_practice.session_section
  ADD CONSTRAINT session_section_section_key_check
  CHECK (section_key ~ '^[a-z0-9][a-z0-9_]{1,79}$') NOT VALID;
ALTER TABLE writing_practice.session_section VALIDATE CONSTRAINT session_section_section_key_check;

ALTER TABLE writing_practice.check_attempt
  DROP CONSTRAINT IF EXISTS check_attempt_section_key_check;
ALTER TABLE writing_practice.check_attempt
  ADD CONSTRAINT check_attempt_section_key_check
  CHECK (section_key ~ '^[a-z0-9][a-z0-9_]{1,79}$') NOT VALID;
ALTER TABLE writing_practice.check_attempt VALIDATE CONSTRAINT check_attempt_section_key_check;

ALTER TABLE writing_practice.comment
  DROP CONSTRAINT IF EXISTS comment_section_key_check;
ALTER TABLE writing_practice.comment
  ADD CONSTRAINT comment_section_key_check
  CHECK (section_key ~ '^[a-z0-9][a-z0-9_]{1,79}$') NOT VALID;
ALTER TABLE writing_practice.comment VALIDATE CONSTRAINT comment_section_key_check;

ALTER TABLE writing_practice.admin_audit_event
  DROP CONSTRAINT IF EXISTS admin_audit_event_section_key_check;
ALTER TABLE writing_practice.admin_audit_event
  ADD CONSTRAINT admin_audit_event_section_key_check
  CHECK (section_key ~ '^[a-z0-9][a-z0-9_]{1,79}$') NOT VALID;
ALTER TABLE writing_practice.admin_audit_event VALIDATE CONSTRAINT admin_audit_event_section_key_check;

CREATE INDEX IF NOT EXISTS activity_section_definition_order_idx
  ON writing_practice.activity_section_definition(activity_id, sort_order);
CREATE INDEX IF NOT EXISTS check_attempt_pool_claim_idx
  ON writing_practice.check_attempt(status, created_at)
  WHERE status IN ('queued','leased');

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'writing_practice_api') THEN
    GRANT SELECT, INSERT, UPDATE ON writing_practice.activity_section_definition TO writing_practice_api;
  END IF;
END $permissions$;

COMMIT;
