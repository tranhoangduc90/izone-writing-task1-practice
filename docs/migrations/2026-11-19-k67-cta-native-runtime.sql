BEGIN;

-- No scope is owned by the native writer until a cutover record is created.
CREATE TABLE reading_listening67.cta_native_owner (
  course_id text PRIMARY KEY,
  class_code text NOT NULL,
  owner text NOT NULL CHECK (owner IN ('n8n', 'draining', 'backend')),
  epoch integer NOT NULL CHECK (epoch > 0),
  changed_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reading_listening67.cta_native_job (
  dispatch_token uuid PRIMARY KEY,
  source_id uuid NOT NULL REFERENCES reading_listening67.source_document(source_id),
  run_id text NOT NULL,
  epoch integer NOT NULL CHECK (epoch > 0),
  state text NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'review', 'error', 'skipped', 'held')),
  lease_token uuid,
  lease_until timestamptz,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  error_code text CHECK (error_code ~ '^[A-Z0-9_|-]{1,200}$'),
  CHECK ((state = 'running') = (lease_token IS NOT NULL AND lease_until IS NOT NULL))
);
CREATE INDEX cta_native_job_due ON reading_listening67.cta_native_job (enqueued_at)
  WHERE state IN ('queued', 'running');

CREATE TABLE reading_listening67.cta_native_slot (
  slot_at timestamptz PRIMARY KEY,
  run_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'done', 'partial', 'failure')),
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);

GRANT SELECT ON reading_listening67.cta_native_owner TO reading_listening67_api;
GRANT SELECT, INSERT, UPDATE ON reading_listening67.cta_native_job, reading_listening67.cta_native_slot TO reading_listening67_api;
COMMIT;
