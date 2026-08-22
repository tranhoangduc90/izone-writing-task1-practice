-- Dữ liệu nhận vào: hai activity Task 2 đang hoạt động; mỗi activity hiện có
-- một lớp CS với roster đã được duyệt và tên hiển thị lấy từ ERP.
-- Việc chính: gắn cả CS.160826 và CS.070626 vào cả hai activity, rồi sao chép
-- đúng roster đã phát hành của từng lớp sang activity còn thiếu.
-- Kết quả: mỗi đề trả về hai lớp; mỗi lớp vẫn chỉ có danh sách học viên của lớp đó.
-- Khi lỗi: transaction rollback toàn bộ; xem lỗi validation trong kết quả psql.
BEGIN;

WITH target_activity AS (
  SELECT id
  FROM writing_practice.activity
  WHERE slug = 'writing-task2-public-health-ban'
    AND status = 'active'
), source_scope AS (
  SELECT scope.erp_course_class_id, scope.class_name_snapshot, scope.end_date
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-living-alone-development'
    AND activity.status = 'active'
    AND scope.erp_course_class_id = 1184
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

WITH target_activity AS (
  SELECT id
  FROM writing_practice.activity
  WHERE slug = 'writing-task2-living-alone-development'
    AND status = 'active'
), source_scope AS (
  SELECT scope.erp_course_class_id, scope.class_name_snapshot, scope.end_date
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-public-health-ban'
    AND activity.status = 'active'
    AND scope.erp_course_class_id = 1283
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

-- Làm mới riêng roster CS.070626 của đề Public Health từ roster đã phát hành.
UPDATE writing_practice.activity_roster roster
SET active = false,
    updated_at = now()
FROM writing_practice.activity_class_scope scope
JOIN writing_practice.activity activity ON activity.id = scope.activity_id
WHERE roster.activity_class_id = scope.id
  AND activity.slug = 'writing-task2-public-health-ban'
  AND scope.erp_course_class_id = 1184;

INSERT INTO writing_practice.activity_roster(
  activity_class_id,
  student_public_id,
  display_name,
  display_alias,
  active
)
SELECT
  target_scope.id,
  source_roster.student_public_id,
  source_roster.display_name,
  source_roster.display_alias,
  true
FROM writing_practice.activity target_activity
JOIN writing_practice.activity_class_scope target_scope
  ON target_scope.activity_id = target_activity.id
  AND target_scope.erp_course_class_id = 1184
JOIN writing_practice.activity source_activity
  ON source_activity.slug = 'writing-task2-living-alone-development'
  AND source_activity.status = 'active'
JOIN writing_practice.activity_class_scope source_scope
  ON source_scope.activity_id = source_activity.id
  AND source_scope.erp_course_class_id = 1184
  AND source_scope.status = 'active'
JOIN writing_practice.activity_roster source_roster
  ON source_roster.activity_class_id = source_scope.id
  AND source_roster.active
WHERE target_activity.slug = 'writing-task2-public-health-ban'
  AND target_activity.status = 'active'
ON CONFLICT(activity_class_id, student_public_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    display_alias = EXCLUDED.display_alias,
    active = true,
    updated_at = now();

-- Làm mới riêng roster CS.160826 của đề Living Alone từ roster đã phát hành.
UPDATE writing_practice.activity_roster roster
SET active = false,
    updated_at = now()
FROM writing_practice.activity_class_scope scope
JOIN writing_practice.activity activity ON activity.id = scope.activity_id
WHERE roster.activity_class_id = scope.id
  AND activity.slug = 'writing-task2-living-alone-development'
  AND scope.erp_course_class_id = 1283;

INSERT INTO writing_practice.activity_roster(
  activity_class_id,
  student_public_id,
  display_name,
  display_alias,
  active
)
SELECT
  target_scope.id,
  source_roster.student_public_id,
  source_roster.display_name,
  source_roster.display_alias,
  true
FROM writing_practice.activity target_activity
JOIN writing_practice.activity_class_scope target_scope
  ON target_scope.activity_id = target_activity.id
  AND target_scope.erp_course_class_id = 1283
JOIN writing_practice.activity source_activity
  ON source_activity.slug = 'writing-task2-public-health-ban'
  AND source_activity.status = 'active'
JOIN writing_practice.activity_class_scope source_scope
  ON source_scope.activity_id = source_activity.id
  AND source_scope.erp_course_class_id = 1283
  AND source_scope.status = 'active'
JOIN writing_practice.activity_roster source_roster
  ON source_roster.activity_class_id = source_scope.id
  AND source_roster.active
WHERE target_activity.slug = 'writing-task2-living-alone-development'
  AND target_activity.status = 'active'
ON CONFLICT(activity_class_id, student_public_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    display_alias = EXCLUDED.display_alias,
    active = true,
    updated_at = now();

DO $validation$
DECLARE
  v_scope_count INTEGER;
  v_all_scope_count INTEGER;
  v_public_health_roster INTEGER;
  v_living_alone_roster INTEGER;
  v_mismatch_count INTEGER;
BEGIN
  SELECT count(*)
  INTO v_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug IN (
      'writing-task2-public-health-ban',
      'writing-task2-living-alone-development'
    )
    AND activity.status = 'active'
    AND scope.status = 'active'
    AND (
      (scope.erp_course_class_id = 1283 AND scope.class_name_snapshot = 'CS.160826')
      OR (scope.erp_course_class_id = 1184 AND scope.class_name_snapshot = 'CS.070626')
    );

  SELECT count(*)
  INTO v_all_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug IN (
      'writing-task2-public-health-ban',
      'writing-task2-living-alone-development'
    )
    AND activity.status = 'active'
    AND scope.status = 'active';

  SELECT count(*)
  INTO v_public_health_roster
  FROM writing_practice.activity_roster roster
  JOIN writing_practice.activity_class_scope scope ON scope.id = roster.activity_class_id
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-public-health-ban'
    AND scope.erp_course_class_id IN (1283, 1184)
    AND scope.status = 'active'
    AND roster.active;

  SELECT count(*)
  INTO v_living_alone_roster
  FROM writing_practice.activity_roster roster
  JOIN writing_practice.activity_class_scope scope ON scope.id = roster.activity_class_id
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-living-alone-development'
    AND scope.erp_course_class_id IN (1283, 1184)
    AND scope.status = 'active'
    AND roster.active;

  WITH released_roster AS (
    SELECT
      activity.slug,
      scope.erp_course_class_id,
      roster.student_public_id,
      roster.display_name,
      roster.display_alias
    FROM writing_practice.activity_roster roster
    JOIN writing_practice.activity_class_scope scope ON scope.id = roster.activity_class_id
    JOIN writing_practice.activity activity ON activity.id = scope.activity_id
    WHERE activity.slug IN (
        'writing-task2-public-health-ban',
        'writing-task2-living-alone-development'
      )
      AND scope.erp_course_class_id IN (1283, 1184)
      AND scope.status = 'active'
      AND roster.active
  ), differences AS (
    (
      SELECT erp_course_class_id, student_public_id, display_name, display_alias
      FROM released_roster
      WHERE slug = 'writing-task2-public-health-ban'
      EXCEPT
      SELECT erp_course_class_id, student_public_id, display_name, display_alias
      FROM released_roster
      WHERE slug = 'writing-task2-living-alone-development'
    )
    UNION ALL
    (
      SELECT erp_course_class_id, student_public_id, display_name, display_alias
      FROM released_roster
      WHERE slug = 'writing-task2-living-alone-development'
      EXCEPT
      SELECT erp_course_class_id, student_public_id, display_name, display_alias
      FROM released_roster
      WHERE slug = 'writing-task2-public-health-ban'
    )
  )
  SELECT count(*) INTO v_mismatch_count FROM differences;

  IF v_scope_count <> 4
     OR v_all_scope_count <> 4
     OR v_public_health_roster <> 43
     OR v_living_alone_roster <> 43
     OR v_mismatch_count <> 0 THEN
    RAISE EXCEPTION
      'Hai đề chưa dùng cùng hai lớp: scope đúng=%, scope tổng=%, Public Health=%, Living Alone=%, lệch roster=%.',
      v_scope_count,
      v_all_scope_count,
      v_public_health_roster,
      v_living_alone_roster,
      v_mismatch_count;
  END IF;
END
$validation$;

COMMIT;
