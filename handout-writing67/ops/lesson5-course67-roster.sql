-- Run in mapping_db as mapping_app. This only reads the daily ERP/mapping snapshot.
BEGIN READ ONLY;
SET LOCAL ROLE mapping_app;
SET LOCAL statement_timeout = '12s';
WITH classes AS (
  SELECT scope.class_id, scope.class_code, scope.membership_observed_at
  FROM mapping.course67_matching_scope scope
  JOIN mapping.classroom_course_mapping class_map
    ON class_map.erp_course_class_id = scope.class_id AND class_map.status = 'approved'
  WHERE scope.active
), students AS (
  SELECT DISTINCT c.class_code, student.public_id::text AS student_ref,
         student.erp_student_name_snapshot AS display_name
  FROM classes c
  JOIN mapping.student_mapping_review student ON student.erp_course_class_id = c.class_id
  JOIN mapping.erp_class_membership_snapshot member
    ON member.erp_course_class_id = c.class_id
   AND member.erp_student_contact_id = student.erp_student_contact_id
  WHERE student.status = 'approved' AND student.classroom_user_id IS NOT NULL
    AND member.source_state = 'active' AND lower(trim(member.registration_status)) NOT IN ('dropped', 'on_hold')
), teachers AS (
  SELECT account.email, account.display_name, account.google_subject,
         array_agg(DISTINCT c.class_code ORDER BY c.class_code) AS class_refs
  FROM mapping.reviewer_account account
  JOIN classes c ON (
    EXISTS (SELECT 1 FROM mapping.reviewer_class_access access
            WHERE access.reviewer_email = account.email AND access.erp_course_class_id = c.class_id)
    OR EXISTS (SELECT 1 FROM mapping.reviewer_class_assignment assignment
               WHERE assignment.reviewer_email = account.email
                 AND upper(trim(assignment.class_name)) = upper(trim(c.class_code)))
  )
  WHERE account.status = 'active' AND nullif(trim(account.google_subject), '') IS NOT NULL
  GROUP BY account.email, account.display_name, account.google_subject
)
SELECT json_build_object(
  'course', '67',
  'observedAt', (SELECT min(membership_observed_at) FROM classes),
  'classes', coalesce((SELECT json_agg(json_build_object(
    'classRef', c.class_code, 'className', c.class_code,
    'students', coalesce((SELECT json_agg(json_build_object(
      'studentRef', s.student_ref, 'displayName', s.display_name) ORDER BY s.display_name, s.student_ref)
      FROM students s WHERE s.class_code = c.class_code), '[]'::json)) ORDER BY c.class_code) FROM classes c), '[]'::json),
  'teachers', coalesce((SELECT json_agg(json_build_object('email', email, 'displayName', display_name,
    'subject', google_subject, 'classes', class_refs) ORDER BY email) FROM teachers), '[]'::json)
);
ROLLBACK;
