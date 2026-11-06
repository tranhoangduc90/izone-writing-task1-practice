-- Recovery is scoped to CTA delivery, never student work or grading receipts.
ALTER TABLE reading_listening67.source_document
  ADD COLUMN IF NOT EXISTS source_version text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS cta_pipeline_version integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cta_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cta_retry_at timestamptz,
  ADD COLUMN IF NOT EXISTS cta_lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS cta_execution_id text,
  ADD COLUMN IF NOT EXISTS cta_proof jsonb;
CREATE INDEX IF NOT EXISTS source_document_cta_recovery
  ON reading_listening67.source_document(cta_state,cta_retry_at,cta_lease_until);
