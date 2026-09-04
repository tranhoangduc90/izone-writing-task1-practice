-- Dữ liệu nhận vào: activity đô thị ở trạng thái bản nháp, manifest đúng checksum,
-- hai lớp Task 2 hiện hành và các ngoại lệ roster đã được duyệt ở đề Living Alone.
-- Việc chính: mở đúng CS.070626 và CS.160826, sao chép ngoại lệ đã duyệt rồi
-- dựng roster mới từ mapping/Classroom hiện hành, không đặt ngày hết hạn;
-- không sao chép hồ sơ tạm.
-- Kết quả: hai lớp nhìn thấy đề mới, mỗi lớp chỉ nhận roster chính thức của mình.
-- PostgreSQL DATE 'infinity' biểu diễn đúng trạng thái không bao giờ hết hạn.
-- Khi lỗi: transaction rollback toàn bộ; đóng activity/scope để rollback, không xóa bài.
-- Cổng an toàn: file này chỉ được chạy production sau khi Đức duyệt trong task hiện tại.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

DO $source_validation$
DECLARE
  v_target_count INTEGER;
  v_template_count INTEGER;
  v_source_scope_count INTEGER;
  v_invalid_override_count INTEGER;
BEGIN
  SELECT count(*)
  INTO v_target_count
  FROM writing_practice.activity
  WHERE slug = 'writing-task2-urban-crowding-traffic-congestion'
    AND content_version = '2026-09-04.1'
    AND manifest_checksum = '6c8c2ebe60f926429a31875e44eebb46630b70ba695495003e946b62b8671296'
    AND prompt_registry_key = 'ielts:writing:task2:web:prompt_registry:v1'
    AND prompt_record_ref = 'task2-web-template-v1'
    AND prompt_version = '2026-08-19.1'
    AND grading_pool = 'task2'
    AND status IN ('draft', 'active');

  SELECT count(*)
  INTO v_template_count
  FROM writing_practice.activity activity
  WHERE activity.slug = 'writing-task2-practice-template'
    AND activity.content_version = '2026-08-19.1'
    AND activity.prompt_record_ref = 'task2-web-template-v1'
    AND activity.prompt_version = '2026-08-19.1'
    AND (
      SELECT count(*)
      FROM writing_practice.activity_section_definition definition
      WHERE definition.activity_id = activity.id
    ) = 4;

  SELECT count(*)
  INTO v_source_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-living-alone-development'
    AND activity.status = 'active'
    AND scope.erp_course_class_id IN (1184, 1283)
    AND scope.status = 'active';

  SELECT count(*)
  INTO v_invalid_override_count
  FROM writing_practice.activity_roster_override roster_override
  JOIN writing_practice.activity_class_scope scope
    ON scope.id = roster_override.activity_class_id
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-living-alone-development'
    AND scope.erp_course_class_id IN (1184, 1283)
    AND roster_override.active
    AND (
      trim(roster_override.display_name) = ''
      OR trim(roster_override.approved_by) = ''
      OR trim(roster_override.reason) = ''
    );

  IF v_target_count <> 1
     OR v_template_count <> 1
     OR v_source_scope_count <> 2
     OR v_invalid_override_count <> 0 THEN
    RAISE EXCEPTION
      'Nguồn phát hành chưa đạt: target=%, template=%, source scopes=%, override lỗi=%.',
      v_target_count,
      v_template_count,
      v_source_scope_count,
      v_invalid_override_count;
  END IF;
END
$source_validation$;

UPDATE writing_practice.activity
SET status = 'active',
    end_date = DATE 'infinity',
    updated_at = now()
WHERE slug = 'writing-task2-urban-crowding-traffic-congestion'
  AND content_version = '2026-09-04.1'
  AND manifest_checksum = '6c8c2ebe60f926429a31875e44eebb46630b70ba695495003e946b62b8671296'
  AND prompt_registry_key = 'ielts:writing:task2:web:prompt_registry:v1'
  AND prompt_record_ref = 'task2-web-template-v1'
  AND prompt_version = '2026-08-19.1'
  AND grading_pool = 'task2'
  AND status IN ('draft', 'active');

WITH target_activity AS (
  SELECT id
  FROM writing_practice.activity
  WHERE slug = 'writing-task2-urban-crowding-traffic-congestion'
    AND content_version = '2026-09-04.1'
    AND status = 'active'
), source_scope AS (
  SELECT
    scope.erp_course_class_id,
    scope.class_name_snapshot,
    DATE 'infinity' AS end_date
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-living-alone-development'
    AND activity.status = 'active'
    AND scope.erp_course_class_id IN (1184, 1283)
    AND scope.status = 'active'
)
INSERT INTO writing_practice.activity_class_scope(
  activity_id,
  erp_course_class_id,
  class_name_snapshot,
  end_date,
  status
)
SELECT
  target.id,
  source.erp_course_class_id,
  source.class_name_snapshot,
  source.end_date,
  'active'
FROM target_activity target
CROSS JOIN source_scope source
ON CONFLICT(activity_id, erp_course_class_id) DO UPDATE
SET class_name_snapshot = EXCLUDED.class_name_snapshot,
    end_date = EXCLUDED.end_date,
    status = EXCLUDED.status;

-- Ngoại lệ được sao chép theo đúng lớp và căn cứ duyệt; hồ sơ tạm không nằm trong bảng này.
WITH target_scope AS (
  SELECT scope.id, scope.erp_course_class_id
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-urban-crowding-traffic-congestion'
    AND scope.erp_course_class_id IN (1184, 1283)
), source_override AS (
  SELECT
    scope.erp_course_class_id,
    roster_override.erp_student_contact_id,
    roster_override.student_public_id,
    roster_override.display_name,
    roster_override.active,
    roster_override.approved_by,
    roster_override.reason
  FROM writing_practice.activity_roster_override roster_override
  JOIN writing_practice.activity_class_scope scope
    ON scope.id = roster_override.activity_class_id
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-living-alone-development'
    AND scope.erp_course_class_id IN (1184, 1283)
    AND roster_override.active
)
INSERT INTO writing_practice.activity_roster_override(
  activity_class_id,
  erp_student_contact_id,
  student_public_id,
  display_name,
  active,
  approved_by,
  reason,
  updated_at
)
SELECT
  target.id,
  source.erp_student_contact_id,
  source.student_public_id,
  source.display_name,
  source.active,
  source.approved_by,
  source.reason,
  now()
FROM target_scope target
JOIN source_override source
  ON source.erp_course_class_id = target.erp_course_class_id
ON CONFLICT(activity_class_id, erp_student_contact_id) DO UPDATE
SET student_public_id = EXCLUDED.student_public_id,
    display_name = EXCLUDED.display_name,
    active = EXCLUDED.active,
    approved_by = EXCLUDED.approved_by,
    reason = EXCLUDED.reason,
    updated_at = now();

-- Hàm này dựng roster từ mapping/Classroom đã duyệt và ngoại lệ nội bộ ở trên.
SELECT writing_practice.refresh_activity_roster(id)
FROM writing_practice.activity
WHERE slug = 'writing-task2-urban-crowding-traffic-congestion'
  AND content_version = '2026-09-04.1'
  AND status = 'active';

DO $validation$
DECLARE
  v_activity_count INTEGER;
  v_section_count INTEGER;
  v_definition_difference_count INTEGER;
  v_active_scope_count INTEGER;
  v_class_difference_count INTEGER;
  v_override_difference_count INTEGER;
  v_roster_difference_count INTEGER;
  v_empty_scope_count INTEGER;
  v_duplicate_alias_group_count INTEGER;
  v_provisional_count INTEGER;
BEGIN
  SELECT count(*)
  INTO v_activity_count
  FROM writing_practice.activity
  WHERE slug = 'writing-task2-urban-crowding-traffic-congestion'
    AND content_version = '2026-09-04.1'
    AND manifest_checksum = '6c8c2ebe60f926429a31875e44eebb46630b70ba695495003e946b62b8671296'
    AND prompt_registry_key = 'ielts:writing:task2:web:prompt_registry:v1'
    AND prompt_record_ref = 'task2-web-template-v1'
    AND prompt_version = '2026-08-19.1'
    AND grading_pool = 'task2'
    AND end_date = DATE 'infinity'
    AND status = 'active';

  SELECT count(*)
  INTO v_section_count
  FROM writing_practice.activity_section_definition definition
  JOIN writing_practice.activity activity ON activity.id = definition.activity_id
  WHERE activity.slug = 'writing-task2-urban-crowding-traffic-congestion';

  WITH target_definition AS (
    SELECT
      definition.section_key,
      definition.title,
      definition.sort_order,
      definition.input_fields,
      definition.context_fields,
      definition.required_fields,
      definition.prerequisite_sections,
      definition.validation_mode,
      definition.prompt_record_ref,
      definition.prompt_version
    FROM writing_practice.activity_section_definition definition
    JOIN writing_practice.activity activity ON activity.id = definition.activity_id
    WHERE activity.slug = 'writing-task2-urban-crowding-traffic-congestion'
  ), source_definition AS (
    SELECT
      definition.section_key,
      definition.title,
      definition.sort_order,
      definition.input_fields,
      definition.context_fields,
      definition.required_fields,
      definition.prerequisite_sections,
      definition.validation_mode,
      definition.prompt_record_ref,
      definition.prompt_version
    FROM writing_practice.activity_section_definition definition
    JOIN writing_practice.activity activity ON activity.id = definition.activity_id
    WHERE activity.slug = 'writing-task2-practice-template'
      AND activity.content_version = '2026-08-19.1'
  ), differences AS (
    (SELECT * FROM target_definition EXCEPT SELECT * FROM source_definition)
    UNION ALL
    (SELECT * FROM source_definition EXCEPT SELECT * FROM target_definition)
  )
  SELECT count(*) INTO v_definition_difference_count FROM differences;

  SELECT count(*)
  INTO v_active_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-urban-crowding-traffic-congestion'
    AND scope.status = 'active';

  WITH target_scope AS (
    SELECT scope.erp_course_class_id, scope.class_name_snapshot, scope.end_date
    FROM writing_practice.activity_class_scope scope
    JOIN writing_practice.activity activity ON activity.id = scope.activity_id
    WHERE activity.slug = 'writing-task2-urban-crowding-traffic-congestion'
      AND scope.status = 'active'
  ), source_scope AS (
    SELECT scope.erp_course_class_id, scope.class_name_snapshot, DATE 'infinity' AS end_date
    FROM writing_practice.activity_class_scope scope
    JOIN writing_practice.activity activity ON activity.id = scope.activity_id
    WHERE activity.slug = 'writing-task2-living-alone-development'
      AND activity.status = 'active'
      AND scope.erp_course_class_id IN (1184, 1283)
      AND scope.status = 'active'
  ), differences AS (
    (SELECT * FROM target_scope EXCEPT SELECT * FROM source_scope)
    UNION ALL
    (SELECT * FROM source_scope EXCEPT SELECT * FROM target_scope)
  )
  SELECT count(*) INTO v_class_difference_count FROM differences;

  WITH target_override AS (
    SELECT
      scope.erp_course_class_id,
      roster_override.erp_student_contact_id,
      roster_override.student_public_id,
      roster_override.display_name,
      roster_override.approved_by,
      roster_override.reason
    FROM writing_practice.activity_roster_override roster_override
    JOIN writing_practice.activity_class_scope scope
      ON scope.id = roster_override.activity_class_id
    JOIN writing_practice.activity activity ON activity.id = scope.activity_id
    WHERE activity.slug = 'writing-task2-urban-crowding-traffic-congestion'
      AND roster_override.active
  ), source_override AS (
    SELECT
      scope.erp_course_class_id,
      roster_override.erp_student_contact_id,
      roster_override.student_public_id,
      roster_override.display_name,
      roster_override.approved_by,
      roster_override.reason
    FROM writing_practice.activity_roster_override roster_override
    JOIN writing_practice.activity_class_scope scope
      ON scope.id = roster_override.activity_class_id
    JOIN writing_practice.activity activity ON activity.id = scope.activity_id
    WHERE activity.slug = 'writing-task2-living-alone-development'
      AND scope.erp_course_class_id IN (1184, 1283)
      AND roster_override.active
  ), differences AS (
    (SELECT * FROM target_override EXCEPT SELECT * FROM source_override)
    UNION ALL
    (SELECT * FROM source_override EXCEPT SELECT * FROM target_override)
  )
  SELECT count(*) INTO v_override_difference_count FROM differences;

  WITH target_scope AS (
    SELECT scope.id, scope.erp_course_class_id
    FROM writing_practice.activity_class_scope scope
    JOIN writing_practice.activity activity ON activity.id = scope.activity_id
    WHERE activity.slug = 'writing-task2-urban-crowding-traffic-congestion'
      AND scope.status = 'active'
  ), approved AS (
    SELECT DISTINCT
      scope.erp_course_class_id,
      review.erp_student_contact_id,
      review.public_id AS student_public_id,
      COALESCE(
        NULLIF(trim(review.erp_student_name_snapshot), ''),
        NULLIF(trim(review.classroom_name_snapshot), ''),
        'Học viên'
      ) AS display_name
    FROM target_scope scope
    JOIN mapping.classroom_course_mapping course
      ON course.erp_course_class_id = scope.erp_course_class_id
      AND course.status = 'approved'
    JOIN mapping.classroom_roster_snapshot classroom
      ON classroom.classroom_course_id = course.classroom_course_id
      AND classroom.roster_state = 'active'
    JOIN mapping.student_mapping_review review
      ON review.erp_course_class_id = course.erp_course_class_id
      AND review.classroom_user_id = classroom.classroom_user_id
      AND review.status = 'approved'
  ), manual_override AS (
    SELECT DISTINCT
      scope.erp_course_class_id,
      roster_override.erp_student_contact_id,
      roster_override.student_public_id,
      trim(roster_override.display_name) AS display_name
    FROM writing_practice.activity_roster_override roster_override
    JOIN target_scope scope ON scope.id = roster_override.activity_class_id
    WHERE roster_override.active
  ), expected_roster AS (
    SELECT erp_course_class_id, student_public_id, display_name FROM approved
    UNION
    SELECT
      manual.erp_course_class_id,
      manual.student_public_id,
      manual.display_name
    FROM manual_override manual
    WHERE NOT EXISTS (
      SELECT 1
      FROM approved
      WHERE approved.erp_course_class_id = manual.erp_course_class_id
        AND approved.erp_student_contact_id = manual.erp_student_contact_id
    )
  ), actual_roster AS (
    SELECT
      scope.erp_course_class_id,
      roster.student_public_id,
      roster.display_name
    FROM writing_practice.activity_roster roster
    JOIN target_scope scope ON scope.id = roster.activity_class_id
    WHERE roster.active
  ), differences AS (
    (SELECT * FROM actual_roster EXCEPT SELECT * FROM expected_roster)
    UNION ALL
    (SELECT * FROM expected_roster EXCEPT SELECT * FROM actual_roster)
  )
  SELECT count(*) INTO v_roster_difference_count FROM differences;

  SELECT count(*)
  INTO v_empty_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-urban-crowding-traffic-congestion'
    AND scope.status = 'active'
    AND NOT EXISTS (
      SELECT 1
      FROM writing_practice.activity_roster roster
      WHERE roster.activity_class_id = scope.id
        AND roster.active
    );

  SELECT count(*)
  INTO v_duplicate_alias_group_count
  FROM (
    SELECT roster.activity_class_id, lower(trim(roster.display_alias))
    FROM writing_practice.activity_roster roster
    JOIN writing_practice.activity_class_scope scope ON scope.id = roster.activity_class_id
    JOIN writing_practice.activity activity ON activity.id = scope.activity_id
    WHERE activity.slug = 'writing-task2-urban-crowding-traffic-congestion'
      AND roster.active
    GROUP BY roster.activity_class_id, lower(trim(roster.display_alias))
    HAVING count(*) > 1
  ) duplicates;

  SELECT count(*)
  INTO v_provisional_count
  FROM writing_practice.provisional_student provisional
  JOIN writing_practice.activity_class_scope scope
    ON scope.id = provisional.activity_class_id
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-urban-crowding-traffic-congestion'
    AND provisional.status = 'pending';

  IF v_activity_count <> 1
     OR v_section_count <> 4
     OR v_definition_difference_count <> 0
     OR v_active_scope_count <> 2
     OR v_class_difference_count <> 0
     OR v_override_difference_count <> 0
     OR v_roster_difference_count <> 0
     OR v_empty_scope_count <> 0
     OR v_duplicate_alias_group_count <> 0
     OR v_provisional_count <> 0 THEN
    RAISE EXCEPTION
      'Phát hành đề đô thị chưa đạt: activity=%, sections=%, definition diff=%, scopes=%, class diff=%, override diff=%, roster diff=%, scope rỗng=%, alias trùng=%, provisional=%.',
      v_activity_count,
      v_section_count,
      v_definition_difference_count,
      v_active_scope_count,
      v_class_difference_count,
      v_override_difference_count,
      v_roster_difference_count,
      v_empty_scope_count,
      v_duplicate_alias_group_count,
      v_provisional_count;
  END IF;
END
$validation$;

COMMIT;
