CREATE TABLE IF NOT EXISTS reading_listening67.web_share_practice (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL,
 course_id text NOT NULL,
 assignment_code text NOT NULL,
 content_version text NOT NULL,
 share_url text NOT NULL,
 request_id uuid NOT NULL,
 status text NOT NULL CHECK(status IN ('queued','processing','accepted','rejected','retry','needs_review')),
 snapshot jsonb,
 analysis_intent boolean NOT NULL DEFAULT false,
 analysis_response jsonb,
 outcome jsonb,
 lease_token uuid,
 lease_until timestamptz,
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,course_id,assignment_code,content_version)
);
CREATE INDEX IF NOT EXISTS web_share_practice_pending ON reading_listening67.web_share_practice(assignment_code,content_version,updated_at) WHERE status='queued';
CREATE TABLE IF NOT EXISTS reading_listening67.web_share_practice_history (
 id uuid PRIMARY KEY,
 owner_id uuid NOT NULL,
 course_id text NOT NULL,
 assignment_code text NOT NULL,
 content_version text NOT NULL,
 request_id uuid NOT NULL,
 data jsonb NOT NULL,
 archived_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(owner_id,course_id,assignment_code,content_version,request_id)
);
CREATE TABLE IF NOT EXISTS reading_listening67.web_share_practice_attempt (
 attempt_id uuid PRIMARY KEY,
 practice_id uuid NOT NULL,
 data jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
