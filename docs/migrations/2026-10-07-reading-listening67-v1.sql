-- Nhận database đã có; tạo vùng riêng để lưu tài liệu, liên kết lớp và lượt chấm.
-- Không sửa bảng Writing/mapping hoặc xóa dữ liệu. Lỗi làm rollback toàn migration.
-- Chưa áp dụng production; tài khoản đăng nhập/mật khẩu được cấp qua quản trị riêng.
BEGIN;
CREATE SCHEMA IF NOT EXISTS reading_listening67;
CREATE TABLE IF NOT EXISTS reading_listening67.document_unit (
  unit_id uuid PRIMARY KEY,
  document_id text NOT NULL CHECK (document_id ~ '^[A-Za-z0-9_-]{20,200}$'),
  tab_id text NOT NULL DEFAULT '',
  assignment_code text NOT NULL CHECK (assignment_code ~ '^67-(reading-0[1-6]|listening-0[1-5])$'),
  source_kind text NOT NULL DEFAULT 'outside_classroom' CHECK (source_kind IN ('outside_classroom','classroom','unverified')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id,tab_id,assignment_code)
);
CREATE TABLE IF NOT EXISTS reading_listening67.classroom_binding (
  binding_id uuid PRIMARY KEY,
  unit_id uuid NOT NULL REFERENCES reading_listening67.document_unit(unit_id),
  course_id text NOT NULL,
  coursework_id text NOT NULL,
  submission_id text NOT NULL,
  student_id text,
  class_code text,
  source_event_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(unit_id,course_id,coursework_id,submission_id)
);
CREATE TABLE IF NOT EXISTS reading_listening67.job (
  job_id text PRIMARY KEY CHECK (job_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  request_id text NOT NULL UNIQUE,
  unit_id uuid NOT NULL REFERENCES reading_listening67.document_unit(unit_id),
  document_id text NOT NULL,
  assignment_code text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','validating','grading','writing','done','incomplete','failed','needs_review')),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_no integer NOT NULL DEFAULT 0 CHECK (attempt_no >= 0),
  dispatch_attempts integer NOT NULL DEFAULT 0,
  dispatch_after timestamptz NOT NULL DEFAULT now(),
  dispatch_token uuid,
  source_revision text,
  template_version text,
  grader_version text,
  answer_sha256 text,
  completion_done integer,
  completion_total integer,
  result jsonb,
  warning_state text NOT NULL DEFAULT 'unchecked' CHECK (warning_state IN ('unchecked','present_verified','absent_verified','write_failed')),
  error_code text,
  execution_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((completion_done IS NULL AND completion_total IS NULL) OR (completion_total > 0 AND completion_done BETWEEN 0 AND completion_total))
);
-- Một tài liệu chỉ có một lượt ghi đang xử lý, kể cả khác kỹ năng/tab.
CREATE UNIQUE INDEX IF NOT EXISTS rl67_one_active_document
  ON reading_listening67.job(document_id) WHERE status IN ('queued','validating','grading','writing','needs_review');
CREATE INDEX IF NOT EXISTS rl67_pending_dispatch ON reading_listening67.job(dispatch_after) WHERE status='queued';
CREATE TABLE IF NOT EXISTS reading_listening67.job_event (
  event_id uuid PRIMARY KEY,
  job_id text NOT NULL REFERENCES reading_listening67.job(job_id),
  event_type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON SCHEMA reading_listening67 FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA reading_listening67 FROM PUBLIC;
COMMIT;
