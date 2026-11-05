-- Additive migration: existing attempts, feedback and section gates are preserved.
CREATE TABLE IF NOT EXISTS writing_practice.deferred_vocabulary_job (
 public_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 attempt_id uuid NOT NULL UNIQUE REFERENCES writing_practice.check_attempt(id),
 session_id uuid NOT NULL REFERENCES writing_practice.activity_session(id),
 round_number integer NOT NULL,
 source_lease_token uuid NOT NULL,
 source_attempt_ref uuid NOT NULL,
 completion_hash text NOT NULL,
 completion_receipt jsonb,
 snapshot_hash text NOT NULL,
 input jsonb NOT NULL,
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','completed','failed','superseded')),
 tries integer NOT NULL DEFAULT 0,
 generation integer NOT NULL DEFAULT 1,
 lease_token uuid,
 lease_until timestamptz,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 error_code text,
 response_hash text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deferred_vocabulary_due_idx
 ON writing_practice.deferred_vocabulary_job(status,next_attempt_at,created_at);
