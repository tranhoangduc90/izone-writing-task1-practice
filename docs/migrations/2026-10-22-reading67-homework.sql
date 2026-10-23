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
