-- Dữ liệu nhận vào: lớp CS.160826 đã có mapping khóa học, 11 ghép tài khoản được duyệt
-- và 12 họ tên đầy đủ trong ERP.
-- Việc chính: ưu tiên họ tên ERP khi làm mới roster, gắn lớp thật vào activity
-- Public Health và thêm ngoại lệ đã phê duyệt cho học viên chưa có tài khoản Classroom.
-- Kết quả: web app hiển thị đủ 12 họ tên theo ERP; trình duyệt không nhận ERP ID,
-- Google ID hoặc email.
-- Khi lỗi: transaction rollback toàn bộ. Đối chiếu bản backup production trước khi chạy lại.
BEGIN;

CREATE OR REPLACE FUNCTION writing_practice.refresh_activity_roster(p_activity_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  -- Tắt roster cũ của đúng activity trước khi dựng lại từ nguồn đã được duyệt.
  UPDATE writing_practice.activity_roster roster
  SET active = false,
      updated_at = now()
  FROM writing_practice.activity_class_scope scope
  WHERE roster.activity_class_id = scope.id
    AND scope.activity_id = p_activity_id;

  -- Ghép học viên đã duyệt và ngoại lệ ERP; tên ERP đầy đủ luôn được ưu tiên hiển thị.
  INSERT INTO writing_practice.activity_roster(
    activity_class_id,
    student_public_id,
    display_name,
    display_alias,
    active
  )
  WITH approved AS (
    SELECT
      scope.id AS activity_class_id,
      review.erp_student_contact_id,
      review.public_id AS student_public_id,
      COALESCE(
        NULLIF(trim(review.erp_student_name_snapshot), ''),
        NULLIF(trim(review.classroom_name_snapshot), ''),
        'Học viên'
      ) AS display_name
    FROM writing_practice.activity_class_scope scope
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
    WHERE scope.activity_id = p_activity_id
  ), manual_override AS (
    SELECT
      roster_override.activity_class_id,
      roster_override.erp_student_contact_id,
      roster_override.student_public_id,
      trim(roster_override.display_name) AS display_name
    FROM writing_practice.activity_roster_override roster_override
    JOIN writing_practice.activity_class_scope scope
      ON scope.id = roster_override.activity_class_id
    WHERE scope.activity_id = p_activity_id
      AND roster_override.active
  ), eligible AS (
    SELECT activity_class_id, erp_student_contact_id, student_public_id, display_name
    FROM approved
    UNION ALL
    SELECT
      manual.activity_class_id,
      manual.erp_student_contact_id,
      manual.student_public_id,
      manual.display_name
    FROM manual_override manual
    WHERE NOT EXISTS (
      SELECT 1
      FROM approved
      WHERE approved.activity_class_id = manual.activity_class_id
        AND approved.erp_student_contact_id = manual.erp_student_contact_id
    )
  )
  SELECT
    activity_class_id,
    student_public_id,
    display_name,
    CASE
      WHEN count(*) OVER (PARTITION BY activity_class_id, lower(display_name)) > 1
        THEN display_name || ' · ' || upper(left(replace(student_public_id::text, '-', ''), 4))
      ELSE display_name
    END,
    true
  FROM eligible
  ON CONFLICT(activity_class_id, student_public_id) DO UPDATE
  SET display_name = EXCLUDED.display_name,
      display_alias = EXCLUDED.display_alias,
      active = true,
      updated_at = now();
END $$;

REVOKE ALL ON FUNCTION writing_practice.refresh_activity_roster(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION writing_practice.refresh_activity_roster(BIGINT)
  TO writing_practice_api;

-- Mở activity đã kiểm thử cho lớp CS.160826 thật.
INSERT INTO writing_practice.activity_class_scope(
  activity_id,
  erp_course_class_id,
  class_name_snapshot,
  end_date,
  status
)
SELECT
  id,
  1283,
  'CS.160826',
  DATE '2026-12-31',
  'active'
FROM writing_practice.activity
WHERE slug = 'writing-task2-public-health-ban'
  AND content_version = '2026-08-20.1'
  AND status = 'active'
ON CONFLICT(activity_id, erp_course_class_id) DO UPDATE
SET class_name_snapshot = EXCLUDED.class_name_snapshot,
    end_date = EXCLUDED.end_date,
    status = EXCLUDED.status;

-- Học viên chưa có tài khoản Classroom vẫn được vào app bằng hồ sơ ERP đã được Đức duyệt.
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
  scope.id,
  review.erp_student_contact_id,
  review.public_id,
  trim(review.erp_student_name_snapshot),
  true,
  'manual_approval_by_admin',
  'Học viên có trong ERP nhưng chưa có tài khoản trong roster Google Classroom tại thời điểm phát hành.',
  now()
FROM writing_practice.activity_class_scope scope
JOIN writing_practice.activity activity
  ON activity.id = scope.activity_id
JOIN mapping.student_mapping_review review
  ON review.erp_course_class_id = scope.erp_course_class_id
WHERE activity.slug = 'writing-task2-public-health-ban'
  AND scope.erp_course_class_id = 1283
  AND review.classroom_user_id IS NULL
  AND trim(review.erp_student_name_snapshot) <> ''
ON CONFLICT(activity_class_id, erp_student_contact_id) DO UPDATE
SET student_public_id = EXCLUDED.student_public_id,
    display_name = EXCLUDED.display_name,
    active = true,
    approved_by = EXCLUDED.approved_by,
    reason = EXCLUDED.reason,
    updated_at = now();

-- Dựng roster và xác nhận đủ 12 tên, đều khớp chính xác với ERP.
SELECT writing_practice.refresh_activity_roster(id)
FROM writing_practice.activity
WHERE slug = 'writing-task2-public-health-ban'
  AND content_version = '2026-08-20.1'
  AND status = 'active';

-- Đóng lớp kiểm thử sau khi đã hoàn tất QA. Giữ dữ liệu cũ để đối soát nhưng
-- không cho lớp và học viên giả xuất hiện trong danh sách production.
UPDATE writing_practice.activity_class_scope scope
SET status = 'closed'
FROM writing_practice.activity activity
WHERE activity.id = scope.activity_id
  AND activity.slug = 'writing-task2-public-health-ban'
  AND scope.erp_course_class_id = -22082026;

UPDATE writing_practice.activity_roster roster
SET active = false,
    updated_at = now()
FROM writing_practice.activity_class_scope scope
JOIN writing_practice.activity activity ON activity.id = scope.activity_id
WHERE roster.activity_class_id = scope.id
  AND activity.slug = 'writing-task2-public-health-ban'
  AND scope.erp_course_class_id = -22082026
  AND roster.student_public_id = '782c4f2f-17ce-48cb-85f5-ad879c1c3e48';

DO $validation$
DECLARE
  v_scope_count INTEGER;
  v_roster_count INTEGER;
  v_erp_name_match_count INTEGER;
  v_override_count INTEGER;
  v_qa_scope_closed_count INTEGER;
  v_qa_roster_count INTEGER;
BEGIN
  SELECT count(*)
  INTO v_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-public-health-ban'
    AND scope.erp_course_class_id = 1283
    AND scope.class_name_snapshot = 'CS.160826'
    AND scope.status = 'active';

  SELECT count(*)
  INTO v_roster_count
  FROM writing_practice.activity_roster roster
  JOIN writing_practice.activity_class_scope scope
    ON scope.id = roster.activity_class_id
  JOIN writing_practice.activity activity
    ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-public-health-ban'
    AND scope.erp_course_class_id = 1283
    AND roster.active;

  SELECT count(*)
  INTO v_erp_name_match_count
  FROM writing_practice.activity_roster roster
  JOIN writing_practice.activity_class_scope scope
    ON scope.id = roster.activity_class_id
  JOIN writing_practice.activity activity
    ON activity.id = scope.activity_id
  JOIN mapping.student_mapping_review review
    ON review.erp_course_class_id = scope.erp_course_class_id
    AND review.public_id = roster.student_public_id
  WHERE activity.slug = 'writing-task2-public-health-ban'
    AND scope.erp_course_class_id = 1283
    AND roster.active
    AND roster.display_name = trim(review.erp_student_name_snapshot);

  SELECT count(*)
  INTO v_override_count
  FROM writing_practice.activity_roster_override roster_override
  JOIN writing_practice.activity_class_scope scope
    ON scope.id = roster_override.activity_class_id
  JOIN writing_practice.activity activity
    ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-public-health-ban'
    AND scope.erp_course_class_id = 1283
    AND roster_override.active;

  SELECT count(*)
  INTO v_qa_scope_closed_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity
    ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-public-health-ban'
    AND scope.erp_course_class_id = -22082026
    AND scope.status = 'closed';

  SELECT count(*)
  INTO v_qa_roster_count
  FROM writing_practice.activity_roster roster
  JOIN writing_practice.activity_class_scope scope
    ON scope.id = roster.activity_class_id
  JOIN writing_practice.activity activity
    ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-public-health-ban'
    AND scope.erp_course_class_id = -22082026
    AND roster.student_public_id = '782c4f2f-17ce-48cb-85f5-ad879c1c3e48'
    AND roster.active;

  IF v_scope_count <> 1
     OR v_roster_count <> 12
     OR v_erp_name_match_count <> 12
     OR v_override_count <> 1
     OR v_qa_scope_closed_count <> 1
     OR v_qa_roster_count <> 0 THEN
    RAISE EXCEPTION
      'Phát hành CS.160826 chưa đủ: scope=%, roster=%, tên ERP=%, ngoại lệ=%, QA đóng=%, QA hiện=%.',
      v_scope_count,
      v_roster_count,
      v_erp_name_match_count,
      v_override_count,
      v_qa_scope_closed_count,
      v_qa_roster_count;
  END IF;
END
$validation$;

COMMIT;
