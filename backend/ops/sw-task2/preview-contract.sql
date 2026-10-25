BEGIN;
DO $$ BEGIN
 IF current_database()<>'sw_task2_preview_20261025' THEN
  RAISE EXCEPTION 'This migration is only for the isolated SW preview database';
 END IF;
END $$;
ALTER TABLE writing_practice.check_attempt
 DROP CONSTRAINT check_attempt_late_callback_token_check;
ALTER TABLE writing_practice.check_attempt
 ADD CONSTRAINT check_attempt_late_callback_token_check
 CHECK(late_callback_token IS NULL OR
  (status='failed' AND error_code IN ('GRADING_TIMEOUT_3_MINUTES','SHOPS_GRADING_TIMEOUT')));
COMMIT;
