BEGIN;

CREATE TABLE reading_listening67.cta_native_enrollment_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  enabled boolean NOT NULL DEFAULT false
);
INSERT INTO reading_listening67.cta_native_enrollment_policy DEFAULT VALUES;

ALTER TABLE reading_listening67.cta_native_owner
  ADD COLUMN enrolled_erp_class_id text CHECK (enrolled_erp_class_id ~ '^[1-9][0-9]{0,19}$'),
  ADD COLUMN enrolled_at timestamptz,
  ADD CONSTRAINT cta_native_owner_enrollment_evidence
    CHECK ((enrolled_at IS NULL) = (enrolled_erp_class_id IS NULL));

-- The scheduler supplies a fresh Portal, approved Mapping and ACTIVE Google pair.
-- This permission only admits an unseen pair. Manual handoffs still own every update.
CREATE FUNCTION reading_listening67.enroll_cta_native_scope(
  new_course text, new_class text, new_erp_class text, observed_at timestamptz
) RETURNS TABLE (status text, epoch integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
SET lock_timeout = '1500ms'
AS $function$
DECLARE
  accepting boolean;
  known reading_listening67.cta_native_owner%ROWTYPE;
  checked_at timestamptz := clock_timestamp();
BEGIN
  IF new_course IS NULL OR new_course !~ '^[1-9][0-9]{0,19}$'
    OR new_class IS NULL OR new_class !~ '^IC[0-9]{1,16}$'
    OR new_erp_class IS NULL OR new_erp_class !~ '^[1-9][0-9]{0,19}$'
    OR observed_at IS NULL OR observed_at < checked_at - interval '10 minutes'
    OR observed_at > checked_at + interval '1 minute' THEN
    RETURN QUERY SELECT 'invalid_evidence'::text, NULL::integer;
    RETURN;
  END IF;

  -- Disabling the switch waits for any in-flight enrollment to commit.
  SELECT p.enabled INTO accepting FROM reading_listening67.cta_native_enrollment_policy p
  WHERE p.singleton FOR UPDATE;
  IF accepting IS DISTINCT FROM true THEN
    RETURN QUERY SELECT 'disabled'::text, NULL::integer;
    RETURN;
  END IF;

  LOCK TABLE reading_listening67.cta_native_owner IN SHARE ROW EXCLUSIVE MODE;
  SELECT o.* INTO known FROM reading_listening67.cta_native_owner o WHERE o.course_id = new_course;
  IF FOUND AND known.class_code = new_class THEN
    IF known.owner = 'backend' THEN
      RETURN QUERY SELECT 'existing'::text, known.epoch;
    ELSE
      RETURN QUERY SELECT known.owner, NULL::integer;
    END IF;
    RETURN;
  END IF;
  IF FOUND OR EXISTS (
    SELECT 1 FROM reading_listening67.cta_native_owner o
    WHERE o.class_code = new_class OR o.enrolled_erp_class_id = new_erp_class
  ) THEN
    RETURN QUERY SELECT 'identity_conflict'::text, NULL::integer;
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM reading_listening67.cta_native_owner)
    OR EXISTS (SELECT 1 FROM reading_listening67.cta_native_owner o WHERE o.owner <> 'backend') THEN
    RETURN QUERY SELECT 'legacy_present'::text, NULL::integer;
    RETURN;
  END IF;

  INSERT INTO reading_listening67.cta_native_owner(course_id,class_code,owner,epoch,enrolled_erp_class_id,enrolled_at)
  VALUES (new_course,new_class,'backend',1,new_erp_class,checked_at);
  RETURN QUERY SELECT 'enrolled'::text, 1;
END;
$function$;

REVOKE ALL ON FUNCTION reading_listening67.enroll_cta_native_scope(text,text,text,timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reading_listening67.enroll_cta_native_scope(text,text,text,timestamptz) TO reading_listening67_api;

COMMIT;
