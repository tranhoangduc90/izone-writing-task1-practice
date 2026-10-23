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
