-- Dữ liệu nhận vào: mười activity duy nhất trong 11 buổi Writing và hai class scope
-- CS.070626/CS.160826 đang hoạt động ở bài ngân sách y tế.
-- Việc chính: mở ba activity mới, thêm đủ hai lớp cho toàn bộ thư viện và dựng lại roster.
-- Kết quả: cả hai lớp dùng được mọi handout; các scope/lớp khác không bị xóa hoặc đóng.
-- Khi lỗi: transaction rollback toàn bộ; xem lỗi validation trong kết quả psql.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '180s';

DO $source_validation$
DECLARE
  v_source_scope_count INTEGER;
  v_target_count INTEGER;
BEGIN
  SELECT count(*)
  INTO v_source_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-public-health-spending'
    AND activity.status = 'active'
    AND scope.erp_course_class_id IN (1184, 1283)
    AND scope.status = 'active';

  SELECT count(*)
  INTO v_target_count
  FROM writing_practice.activity
  WHERE status IN ('draft', 'active')
    AND slug IN (
      'writing-task2-public-health-ban',
      'writing-task2-public-health-spending',
      'writing-task2-live-performances-at-home',
      'writing-task2-crime-prevention-responsibility',
      'australian-physical-activity-2010',
      'new-zealand-employment-1993-2003',
      'pie-app-users-by-age',
      'australian-destinations-1999-2009',
      'writing-task2-living-alone-development',
      'writing-task2-urban-crowding-traffic-congestion'
    );

  IF v_source_scope_count <> 2 OR v_target_count <> 10 THEN
    RAISE EXCEPTION 'Nguồn mở lớp chưa đạt: source scopes=%, target activities=%.',
      v_source_scope_count, v_target_count;
  END IF;
END
$source_validation$;

UPDATE writing_practice.activity
SET status = 'active',
    end_date = DATE '2026-12-31',
    updated_at = now()
WHERE (slug, content_version) IN (
  ('australian-physical-activity-2010', 'task1-web-activity-v1'),
  ('new-zealand-employment-1993-2003', 'task1-web-activity-v1'),
  ('writing-task2-crime-prevention-responsibility', '2026-09-13.1')
)
  AND status IN ('draft', 'active');

-- Hai manifest Task 1 hiện hành chỉ được bổ sung đúng link chatbot từ homework;
-- checksum phải khớp file public để API và trình duyệt dùng cùng một phiên bản.
UPDATE writing_practice.activity
SET manifest_checksum = CASE slug
      WHEN 'pie-app-users-by-age' THEN '34dfc1a458c8f95b8cbc57586573e79a819131409a0a1a402f161a90943541d1'
      WHEN 'australian-destinations-1999-2009' THEN '92e27d59026d4def5d007935e94ceedaae138b64f4966c3989447989e85e5612'
    END,
    updated_at = now()
WHERE (slug = 'pie-app-users-by-age' AND prompt_record_ref = 'recvqPmgd9l5P1' AND prompt_version = '1')
   OR (slug = 'australian-destinations-1999-2009' AND prompt_record_ref = 'recvs8H9ghfkdz' AND prompt_version = '1');

WITH target_activity AS (
  SELECT id
  FROM writing_practice.activity
  WHERE status = 'active'
    AND slug IN (
      'writing-task2-public-health-ban',
      'writing-task2-public-health-spending',
      'writing-task2-live-performances-at-home',
      'writing-task2-crime-prevention-responsibility',
      'australian-physical-activity-2010',
      'new-zealand-employment-1993-2003',
      'pie-app-users-by-age',
      'australian-destinations-1999-2009',
      'writing-task2-living-alone-development',
      'writing-task2-urban-crowding-traffic-congestion'
    )
), source_scope AS (
  SELECT
    scope.erp_course_class_id,
    scope.class_name_snapshot
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-public-health-spending'
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
  DATE '2026-12-31',
  'active'
FROM target_activity target
CROSS JOIN source_scope source
ON CONFLICT(activity_id, erp_course_class_id) DO UPDATE
SET class_name_snapshot = EXCLUDED.class_name_snapshot,
    end_date = EXCLUDED.end_date,
    status = EXCLUDED.status;

WITH target_scope AS (
  SELECT scope.id, scope.erp_course_class_id
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.status = 'active'
    AND activity.slug IN (
      'writing-task2-public-health-ban',
      'writing-task2-public-health-spending',
      'writing-task2-live-performances-at-home',
      'writing-task2-crime-prevention-responsibility',
      'australian-physical-activity-2010',
      'new-zealand-employment-1993-2003',
      'pie-app-users-by-age',
      'australian-destinations-1999-2009',
      'writing-task2-living-alone-development',
      'writing-task2-urban-crowding-traffic-congestion'
    )
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
  JOIN writing_practice.activity_class_scope scope ON scope.id = roster_override.activity_class_id
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-public-health-spending'
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
JOIN source_override source ON source.erp_course_class_id = target.erp_course_class_id
ON CONFLICT(activity_class_id, erp_student_contact_id) DO UPDATE
SET student_public_id = EXCLUDED.student_public_id,
    display_name = EXCLUDED.display_name,
    active = EXCLUDED.active,
    approved_by = EXCLUDED.approved_by,
    reason = EXCLUDED.reason,
    updated_at = now();

SELECT writing_practice.refresh_activity_roster(activity.id)
FROM writing_practice.activity activity
WHERE activity.status = 'active'
  AND activity.slug IN (
    'writing-task2-public-health-ban',
    'writing-task2-public-health-spending',
    'writing-task2-live-performances-at-home',
    'writing-task2-crime-prevention-responsibility',
    'australian-physical-activity-2010',
    'new-zealand-employment-1993-2003',
    'pie-app-users-by-age',
    'australian-destinations-1999-2009',
    'writing-task2-living-alone-development',
    'writing-task2-urban-crowding-traffic-congestion'
  );

DO $validation$
DECLARE
  v_activity_count INTEGER;
  v_expected_scope_count INTEGER;
  v_empty_scope_count INTEGER;
  v_duplicate_alias_group_count INTEGER;
BEGIN
  SELECT count(*)
  INTO v_activity_count
  FROM writing_practice.activity
  WHERE status = 'active'
    AND slug IN (
      'writing-task2-public-health-ban',
      'writing-task2-public-health-spending',
      'writing-task2-live-performances-at-home',
      'writing-task2-crime-prevention-responsibility',
      'australian-physical-activity-2010',
      'new-zealand-employment-1993-2003',
      'pie-app-users-by-age',
      'australian-destinations-1999-2009',
      'writing-task2-living-alone-development',
      'writing-task2-urban-crowding-traffic-congestion'
    );

  SELECT count(*)
  INTO v_expected_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.status = 'active'
    AND activity.slug IN (
      'writing-task2-public-health-ban',
      'writing-task2-public-health-spending',
      'writing-task2-live-performances-at-home',
      'writing-task2-crime-prevention-responsibility',
      'australian-physical-activity-2010',
      'new-zealand-employment-1993-2003',
      'pie-app-users-by-age',
      'australian-destinations-1999-2009',
      'writing-task2-living-alone-development',
      'writing-task2-urban-crowding-traffic-congestion'
    )
    AND scope.erp_course_class_id IN (1184, 1283)
    AND scope.status = 'active';

  SELECT count(*)
  INTO v_empty_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.status = 'active'
    AND activity.slug IN (
      'writing-task2-public-health-ban',
      'writing-task2-public-health-spending',
      'writing-task2-live-performances-at-home',
      'writing-task2-crime-prevention-responsibility',
      'australian-physical-activity-2010',
      'new-zealand-employment-1993-2003',
      'pie-app-users-by-age',
      'australian-destinations-1999-2009',
      'writing-task2-living-alone-development',
      'writing-task2-urban-crowding-traffic-congestion'
    )
    AND scope.erp_course_class_id IN (1184, 1283)
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
    WHERE activity.status = 'active'
      AND activity.slug IN (
        'writing-task2-public-health-ban',
        'writing-task2-public-health-spending',
        'writing-task2-live-performances-at-home',
        'writing-task2-crime-prevention-responsibility',
        'australian-physical-activity-2010',
        'new-zealand-employment-1993-2003',
        'pie-app-users-by-age',
        'australian-destinations-1999-2009',
        'writing-task2-living-alone-development',
        'writing-task2-urban-crowding-traffic-congestion'
      )
      AND scope.erp_course_class_id IN (1184, 1283)
      AND roster.active
    GROUP BY roster.activity_class_id, lower(trim(roster.display_alias))
    HAVING count(*) > 1
  ) duplicates;

  IF v_activity_count <> 10
     OR v_expected_scope_count <> 20
     OR v_empty_scope_count <> 0
     OR v_duplicate_alias_group_count <> 0 THEN
    RAISE EXCEPTION 'Mở toàn bộ thư viện chưa đạt: activities=%, scopes=%, empty scopes=%, duplicate aliases=%.',
      v_activity_count, v_expected_scope_count, v_empty_scope_count, v_duplicate_alias_group_count;
  END IF;
END
$validation$;

COMMIT;
