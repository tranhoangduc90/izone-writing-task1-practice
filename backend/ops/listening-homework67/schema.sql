-- Apply only to the new listening_homework67 database.
-- Nhận nháp web có chủ/version, lưu lượt gửi bất biến và kết quả riêng.
-- Chỉ chạy trên database thử ở chặng 2; chưa áp dụng production hoặc đổi bảng Docs cũ.
CREATE SCHEMA IF NOT EXISTS reading_listening67;
CREATE TABLE IF NOT EXISTS reading_listening67.web_draft (
  owner_id text NOT NULL, course_id text NOT NULL, assignment_code text NOT NULL,
  content_version text NOT NULL, revision integer NOT NULL DEFAULT 0 CHECK(revision >= 0),
  run_no integer NOT NULL DEFAULT 1,
  body jsonb NOT NULL DEFAULT '{"answers":{},"annotations":[],"notes":"","flags":[]}',
  saved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,course_id,assignment_code,content_version)
);
CREATE TABLE IF NOT EXISTS reading_listening67.web_mutation (
  owner_id text NOT NULL, course_id text NOT NULL, assignment_code text NOT NULL,
  content_version text NOT NULL, mutation_id uuid NOT NULL, request_hash text NOT NULL,
  response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(owner_id,course_id,assignment_code,content_version,mutation_id)
);
CREATE TABLE IF NOT EXISTS reading_listening67.web_attempt (
  id uuid PRIMARY KEY, owner_id text NOT NULL, course_id text NOT NULL,
  assignment_code text NOT NULL, content_version text NOT NULL,
  draft_revision integer NOT NULL, snapshot jsonb NOT NULL, run_no integer NOT NULL DEFAULT 1,
  input_hash text NOT NULL, grader_hash text NOT NULL, completeness jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS web_attempt_owner ON reading_listening67.web_attempt(owner_id,course_id,assignment_code,content_version,created_at DESC);
ALTER TABLE reading_listening67.web_draft ADD COLUMN IF NOT EXISTS run_no integer NOT NULL DEFAULT 1;
ALTER TABLE reading_listening67.web_attempt ADD COLUMN IF NOT EXISTS run_no integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS reading_listening67.web_job (
  id uuid PRIMARY KEY, attempt_id uuid NOT NULL UNIQUE REFERENCES reading_listening67.web_attempt(id),
  status text NOT NULL CHECK(status IN ('queued','processing','done','failed','needs_review')),
  lease_token uuid, lease_until timestamptz, provider_response jsonb,
  error_code text, created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS web_job_waiting ON reading_listening67.web_job(status,created_at);
CREATE TABLE IF NOT EXISTS reading_listening67.web_request (
  owner_id text NOT NULL, course_id text NOT NULL, assignment_code text NOT NULL,
  content_version text NOT NULL, request_id uuid NOT NULL, request_hash text NOT NULL,
  attempt_id uuid NOT NULL REFERENCES reading_listening67.web_attempt(id),
  PRIMARY KEY(owner_id,course_id,assignment_code,content_version,request_id)
);
CREATE TABLE IF NOT EXISTS reading_listening67.web_result (
  attempt_id uuid PRIMARY KEY REFERENCES reading_listening67.web_attempt(id),
  data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reading_listening67.web_draft_archive (
 id uuid PRIMARY KEY, owner_id text NOT NULL, course_id text NOT NULL,
 assignment_code text NOT NULL, content_version text NOT NULL,
 run_no integer NOT NULL, revision integer NOT NULL, body jsonb NOT NULL,
 saved_at timestamptz, archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reading_listening67.web_student_session (
 token_hash text PRIMARY KEY, owner_id uuid NOT NULL, course_id text NOT NULL,
 erp_id text NOT NULL, expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS reading_listening67.web_teacher_session (
 token_hash text PRIMARY KEY, email text NOT NULL, google_subject text NOT NULL,
 expires_at timestamptz NOT NULL, absolute_expires_at timestamptz NOT NULL,
 remembered boolean NOT NULL
);
ALTER TABLE reading_listening67.web_draft ADD COLUMN IF NOT EXISTS run_no integer NOT NULL DEFAULT 1;
ALTER TABLE reading_listening67.web_attempt ADD COLUMN IF NOT EXISTS run_no integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS reading_listening67.web_draft_archive (
 id uuid PRIMARY KEY, owner_id text NOT NULL, course_id text NOT NULL,
 assignment_code text NOT NULL, content_version text NOT NULL,
 run_no integer NOT NULL, revision integer NOT NULL, body jsonb NOT NULL,
 saved_at timestamptz, archived_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS reading_listening67.web_homework_binding (
 id uuid PRIMARY KEY, owner_id text NOT NULL, course_id text NOT NULL,
 assignment_code text NOT NULL, content_version text NOT NULL,
 target jsonb, sequence integer NOT NULL DEFAULT 0,
 started_run_no integer NOT NULL DEFAULT 0,
 selected_attempt_id uuid, selected_run_no integer,
 last_doc_sequence integer NOT NULL DEFAULT -1,
 last_doc_text text NOT NULL DEFAULT '', last_doc_link text NOT NULL DEFAULT '',
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,course_id,assignment_code,content_version)
);
CREATE TABLE IF NOT EXISTS reading_listening67.web_homework_job (
 id uuid PRIMARY KEY, binding_id uuid NOT NULL REFERENCES reading_listening67.web_homework_binding(id),
 event_key text NOT NULL, sequence integer NOT NULL,
 kind text NOT NULL CHECK(kind IN ('cta','status')), payload jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','processing','verified','blocked')),
 attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(),
 lease_id uuid, lease_until timestamptz, error_code text,
 created_at timestamptz NOT NULL DEFAULT now(), verified_at timestamptz,
 UNIQUE(binding_id,event_key), UNIQUE(binding_id,sequence)
);
CREATE INDEX IF NOT EXISTS web_homework_job_ready ON reading_listening67.web_homework_job(status,available_at);

-- Lịch sử kiểm/bổ sung. Không cập nhật bản nộp, nháp hoặc kết quả cũ.
CREATE TABLE IF NOT EXISTS reading_listening67.web_validation (
 job_id uuid PRIMARY KEY REFERENCES reading_listening67.web_job(id),
 state jsonb NOT NULL DEFAULT '{}', next_attempt_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reading_listening67.web_validation_round (
 call_id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES reading_listening67.web_job(id),
 phase text NOT NULL, round_no integer, status text NOT NULL,
 prompt_hash text, response jsonb, metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS web_validation_round_job ON reading_listening67.web_validation_round(job_id,created_at);
CREATE TABLE IF NOT EXISTS reading_listening67.web_validation_event (
 id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES reading_listening67.web_job(id),
 kind text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
