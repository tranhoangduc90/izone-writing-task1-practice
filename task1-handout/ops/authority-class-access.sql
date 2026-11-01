-- Apply to the authority source mapping_db, never sw_task1.
-- Dedicated Task 1 classes may not exist in the frozen legacy class mapping.
-- Input: explicitly approved reviewer email / ERP class ID pairs.
-- Output: the existing identity bridge includes those IDs after account and
-- Google-subject validation; the consumer still checks its own class scopes.
CREATE TABLE IF NOT EXISTS task1_bridge.reviewer_class_access (
  reviewer_email text NOT NULL REFERENCES mapping.reviewer_account(email),
  erp_course_class_id bigint NOT NULL,
  PRIMARY KEY (reviewer_email, erp_course_class_id)
);
REVOKE ALL ON task1_bridge.reviewer_class_access FROM PUBLIC;

CREATE OR REPLACE FUNCTION task1_bridge.identity_grant(e text, s text)
RETURNS TABLE(role text, can_access_all_classes boolean, class_ids bigint[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'pg_catalog'
AS $function$
  SELECT a.role, a.can_access_all_classes, ARRAY(
    SELECT DISTINCT c.erp_course_class_id
    FROM writing_practice.activity_class_scope c
    JOIN writing_practice.activity t ON t.id=c.activity_id
    WHERE t.grading_pool='task1' AND (
      a.can_access_all_classes
      OR EXISTS(SELECT 1 FROM mapping.reviewer_class_access x
        WHERE x.reviewer_email=a.email AND x.erp_course_class_id=c.erp_course_class_id)
      OR EXISTS(SELECT 1 FROM mapping.lark_export_teacher_assignments x
        WHERE lower(trim(x.payload->>'Email tài khoản'))=lower(a.email)
          AND c.erp_course_class_id=ANY(x.scope_class_ids)
          AND lower(trim(x.payload->>'Trạng thái tài khoản'))='active'
          AND x.source_status='Đang có trong nguồn')
    )
    UNION
    SELECT x.erp_course_class_id FROM task1_bridge.reviewer_class_access x
    WHERE x.reviewer_email=a.email
  )
  FROM mapping.reviewer_account a
  WHERE a.email=e AND a.google_subject=s AND a.status='active'
$function$;

-- CREATE OR REPLACE retains the existing function owner. Give only that owner
-- read access to the new table, without exposing it to the consumer DB role.
DO $grant$
DECLARE function_owner text;
BEGIN
  SELECT pg_get_userbyid(proowner) INTO function_owner FROM pg_proc
    WHERE oid='task1_bridge.identity_grant(text,text)'::regprocedure;
  EXECUTE format('GRANT SELECT ON task1_bridge.reviewer_class_access TO %I', function_owner);
END
$grant$;
