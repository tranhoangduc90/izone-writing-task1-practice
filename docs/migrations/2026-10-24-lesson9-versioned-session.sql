-- Additive; không pin hoặc chuyển bất kỳ phiên cũ nào.
BEGIN;
CREATE TABLE IF NOT EXISTS writing_practice.lesson9_rollout (
 activity_id bigint PRIMARY KEY REFERENCES writing_practice.activity(id),
 ui_version text NOT NULL CHECK(ui_version='shops-lesson9-v1'), starts_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS writing_practice.lesson9_session_state (
 session_id uuid PRIMARY KEY REFERENCES writing_practice.activity_session(id),
 ui_version text NOT NULL, data jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE TABLE IF NOT EXISTS writing_practice.lesson9_action (
 session_id uuid NOT NULL REFERENCES writing_practice.activity_session(id),
 request_id uuid NOT NULL,kind text NOT NULL,body_hash text NOT NULL,
 before_data jsonb NOT NULL,after_data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(session_id,request_id)
);
CREATE TABLE IF NOT EXISTS writing_practice.lesson9_vocabulary_job (
 public_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),session_id uuid NOT NULL REFERENCES writing_practice.activity_session(id),
 request_id uuid NOT NULL,snapshot_hash text NOT NULL,snapshot jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN('queued','leased','completed','failed','superseded')),
 attempts integer NOT NULL DEFAULT 0,lease_token uuid,lease_until timestamptz,groups jsonb NOT NULL DEFAULT '{}'::jsonb,
 error_code text,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(session_id,snapshot_hash)
);
COMMIT;
