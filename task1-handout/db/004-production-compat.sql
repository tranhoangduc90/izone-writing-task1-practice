-- Preserve all legacy Task 1 fields without importing external mapping schemas.
ALTER TABLE writing_practice.activity_section_definition ADD COLUMN prerequisite_sections jsonb NOT NULL DEFAULT '[]';
ALTER TABLE writing_practice.check_attempt ADD COLUMN grading_context jsonb, ADD COLUMN grading_meta jsonb;
ALTER TABLE writing_practice.provisional_student ADD COLUMN deleted_at timestamptz, ADD COLUMN deleted_by text;
ALTER TABLE writing_practice.provisional_student DROP CONSTRAINT provisional_student_status_check;
ALTER TABLE writing_practice.provisional_student ADD CHECK(status IN ('pending','matched','conflict','deleted'));
ALTER TABLE writing_practice.provisional_student_audit DROP CONSTRAINT provisional_student_audit_action_check;
ALTER TABLE writing_practice.provisional_student_audit ADD CHECK(action IN ('created','code_reset','matched','conflict_detected','deleted'));
CREATE TABLE writing_practice.activity_roster_override(
 activity_class_id bigint NOT NULL REFERENCES writing_practice.activity_class_scope(id),erp_student_contact_id bigint NOT NULL,
 student_public_id uuid NOT NULL DEFAULT gen_random_uuid(),display_name text NOT NULL,active boolean NOT NULL DEFAULT true,
 approved_by text NOT NULL,reason text NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(activity_class_id,erp_student_contact_id)
);
CREATE TABLE writing_practice.grading_dispatch(
 event_ref uuid PRIMARY KEY DEFAULT gen_random_uuid(),attempt_id uuid NOT NULL REFERENCES writing_practice.check_attempt(id),attempt_ref uuid NOT NULL,
 worker_pool text NOT NULL,dispatch_token uuid NOT NULL DEFAULT gen_random_uuid(),state text NOT NULL DEFAULT 'pending',execution_id text,workflow_id text,
 queued_at timestamptz NOT NULL DEFAULT now(),dispatched_at timestamptz,last_sent_at timestamptz,finished_at timestamptz,updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE task1_private.official_student(student_public_id uuid PRIMARY KEY,erp_student_contact_id bigint NOT NULL,display_name text NOT NULL);
CREATE TABLE task1_private.cutover_state(id int PRIMARY KEY CHECK(id=1),phase text NOT NULL CHECK(phase IN ('prepared','live')));
INSERT INTO task1_private.cutover_state VALUES(1,'prepared');
CREATE TABLE task1_private.migration_archive(sha256 text PRIMARY KEY,original_text text NOT NULL,captured_at timestamptz NOT NULL,imported_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION writing_practice.resolve_official_student(p uuid) RETURNS TABLE(erp_student_contact_id bigint,student_public_id uuid,display_name text)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$ SELECT o.erp_student_contact_id,o.student_public_id,o.display_name FROM task1_private.official_student o WHERE o.student_public_id=p $$;
GRANT SELECT,INSERT,UPDATE ON writing_practice.activity_roster_override TO task1_api;
GRANT SELECT ON writing_practice.grading_dispatch TO task1_api;
GRANT SELECT,INSERT,UPDATE ON task1_private.official_student TO task1_api;
REVOKE ALL ON FUNCTION writing_practice.resolve_official_student(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION writing_practice.resolve_official_student(uuid) TO task1_api;
