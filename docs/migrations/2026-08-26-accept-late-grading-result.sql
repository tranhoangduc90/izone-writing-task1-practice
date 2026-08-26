BEGIN;

ALTER TABLE writing_practice.check_attempt
  ADD COLUMN IF NOT EXISTS late_callback_token UUID;

ALTER TABLE writing_practice.check_attempt
  DROP CONSTRAINT IF EXISTS check_attempt_late_callback_token_check;

ALTER TABLE writing_practice.check_attempt
  ADD CONSTRAINT check_attempt_late_callback_token_check
  CHECK (
    late_callback_token IS NULL
    OR (status='failed' AND error_code='GRADING_TIMEOUT_3_MINUTES')
  ) NOT VALID;

ALTER TABLE writing_practice.check_attempt
  VALIDATE CONSTRAINT check_attempt_late_callback_token_check;

COMMIT;
