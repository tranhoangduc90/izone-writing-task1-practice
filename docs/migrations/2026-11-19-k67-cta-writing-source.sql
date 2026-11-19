BEGIN;
CREATE TABLE reading_listening67.cta_native_writing_source (
  source_key text PRIMARY KEY CHECK (source_key ~ '^[a-f0-9]{64}$'),
  course_id text NOT NULL,
  class_code text NOT NULL,
  epoch integer NOT NULL CHECK (epoch > 0),
  event jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','verified','not_applicable','review')),
  attempts integer NOT NULL DEFAULT 0,
  eligible_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  error_code text,
  CHECK ((state = 'running') = (lease_until IS NOT NULL AND lease_token IS NOT NULL))
);
CREATE INDEX cta_native_writing_due ON reading_listening67.cta_native_writing_source(eligible_at)
  WHERE state IN ('pending','running');
GRANT SELECT, INSERT, UPDATE ON reading_listening67.cta_native_writing_source TO reading_listening67_api;
COMMIT;
