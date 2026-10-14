WITH mapped_courses AS (
  SELECT course.erp_course_class_id,
    course.erp_class_name_snapshot,course.classroom_course_id,
    course.classroom_course_name_snapshot,course.classroom_section_snapshot,
    course.status AS mapping_status,
    course.updated_at,
    CASE WHEN verified.after_state->>'erpStatusVerified'='true'
      AND verified.after_state->>'classStatus'='completed'
      THEN ARRAY[verified.after_state->>'classStatus']::text[]
      ELSE coalesce(array_agg(DISTINCT lower(access.class_status_snapshot))
        FILTER (WHERE access.class_status_snapshot IS NOT NULL),ARRAY[]::text[])
      END AS class_statuses,
    coalesce(array_agg(DISTINCT account.display_name ORDER BY account.display_name)
      FILTER (WHERE account.status='active' AND nullif(trim(account.display_name),'') IS NOT NULL),
      ARRAY[]::text[]) AS teacher_names,
    'mapping:' || course.erp_course_class_id::text AS source_ref
  FROM mapping.classroom_course_mapping AS course
  LEFT JOIN mapping.reviewer_class_access AS access
    ON access.erp_course_class_id=course.erp_course_class_id
  LEFT JOIN mapping.reviewer_account AS account ON account.email=access.reviewer_email
  -- Sự thật ERP đã được người vận hành kiểm trực tiếp giữ riêng ở Writing.
  -- Không sửa snapshot phân công giảng viên dùng chung hoặc bật lại lớp đã hoàn thành.
  LEFT JOIN LATERAL (
    SELECT event.after_state FROM writing_flow.operator_event AS event
    WHERE event.event_type='class_mapping_changed'
      AND event.after_state->>'erpStatusVerified'='true'
      AND event.after_state->>'erpCourseClassId'=course.erp_course_class_id::text
    ORDER BY event.created_at DESC,event.event_id DESC LIMIT 1
  ) AS verified ON true
  GROUP BY course.erp_course_class_id,course.erp_class_name_snapshot,
    course.classroom_course_id,course.classroom_course_name_snapshot,
    course.classroom_section_snapshot,
    course.status,course.updated_at,verified.after_state
), direct_courses AS (
  SELECT NULL::bigint AS erp_course_class_id,
    direct.class_name_snapshot AS erp_class_name_snapshot,
    direct.classroom_course_id,
    direct.classroom_course_name_snapshot,
    direct.classroom_section_snapshot,
    direct.status AS mapping_status,
    direct.updated_at,
    ARRAY[direct.class_status]::text[] AS class_statuses,
    ARRAY[]::text[] AS teacher_names,
    'classroom_direct:' || direct.class_code AS source_ref
  FROM mapping.classroom_direct_class AS direct
)
SELECT * FROM mapped_courses
UNION ALL
SELECT * FROM direct_courses
ORDER BY erp_class_name_snapshot,erp_course_class_id NULLS LAST
