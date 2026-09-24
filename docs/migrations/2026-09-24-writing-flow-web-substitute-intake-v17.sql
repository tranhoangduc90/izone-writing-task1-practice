-- Dữ liệu vào: phiếu lượt đã được tra roster bằng hàm v16, rồi bài web đã kiểm đề/Task.
-- Việc chính: lưu lượt, bài mã hóa và hàng chờ dùng chung backend Writing.
-- Kết quả: HTTP 202 chỉ được phép trả sau khi cả lượt và bài đã commit/readback.
-- Khi lỗi: transaction rollback; không tạo điểm hoặc sửa hàng chờ Term/Homework.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));

CREATE TABLE IF NOT EXISTS writing_flow.web_substitute_attempt (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  test_slug text NOT NULL,
  cohort smallint NOT NULL CHECK (cohort IN (56, 67)),
  erp_course_class_id bigint NOT NULL CHECK (erp_course_class_id > 0),
  erp_student_contact_id bigint NOT NULL CHECK (erp_student_contact_id > 0),
  task_number smallint NOT NULL CHECK (task_number IN (1, 2)),
  attempt_no integer NOT NULL DEFAULT 1 CHECK (attempt_no > 0),
  rubric_version text NOT NULL CHECK (length(rubric_version) BETWEEN 3 AND 120),
  status text NOT NULL DEFAULT 'open' CHECK (status IN (
    'open', 'submitted', 'needs_review', 'completed'
  )),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, task_number),
  UNIQUE (test_slug, erp_course_class_id, erp_student_contact_id, attempt_no),
  FOREIGN KEY (test_slug, erp_course_class_id)
    REFERENCES writing_flow.web_substitute_access(test_slug, erp_course_class_id),
  CONSTRAINT web_substitute_attempt_slug_cohort_check CHECK (
    (cohort = 56 AND right(test_slug, 3) = 'k56') OR
    (cohort = 67 AND right(test_slug, 3) = 'k67')
  )
);

CREATE TABLE IF NOT EXISTS writing_flow.web_substitute_submission (
  submission_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL,
  task_number smallint NOT NULL,
  run_key uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  content_ciphertext bytea NOT NULL,
  content_sha256 char(64) NOT NULL
    CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  prompt_sha256 char(64) NOT NULL
    CHECK (prompt_sha256 ~ '^[0-9a-f]{64}$'),
  image_sha256 char(64)
    CHECK (image_sha256 IS NULL OR image_sha256 ~ '^[0-9a-f]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'completed', 'needs_review', 'delivered'
  )),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  result_ciphertext bytea,
  result_sha256 char(64)
    CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  task_score numeric(3,1) CHECK (task_score IS NULL OR
    (task_score >= 0 AND task_score <= 9)),
  completed_at timestamptz,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (attempt_id, task_number),
  FOREIGN KEY (attempt_id, task_number)
    REFERENCES writing_flow.web_substitute_attempt(attempt_id, task_number),
  CONSTRAINT web_substitute_submission_lease_check CHECK (
    (status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT web_substitute_submission_result_check CHECK (
    (status IN ('completed', 'delivered')) =
      (result_ciphertext IS NOT NULL AND result_sha256 IS NOT NULL
       AND task_score IS NOT NULL AND completed_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS web_substitute_submission_due_idx
  ON writing_flow.web_substitute_submission
  (next_attempt_at, created_at, submission_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS web_substitute_submission_expired_idx
  ON writing_flow.web_substitute_submission
  (lease_expires_at, submission_id)
  WHERE status = 'running';

REVOKE ALL ON writing_flow.web_substitute_attempt,
  writing_flow.web_substitute_submission FROM PUBLIC;
GRANT SELECT, INSERT ON writing_flow.web_substitute_attempt,
  writing_flow.web_substitute_submission TO writing_practice_api;
GRANT UPDATE (status, updated_at) ON writing_flow.web_substitute_attempt
  TO writing_practice_api;
GRANT UPDATE (status, attempt_count, next_attempt_at, lease_token,
  lease_expires_at, result_ciphertext, result_sha256, task_score,
  completed_at, last_error_code, updated_at)
  ON writing_flow.web_substitute_submission TO writing_practice_api;

COMMIT;
