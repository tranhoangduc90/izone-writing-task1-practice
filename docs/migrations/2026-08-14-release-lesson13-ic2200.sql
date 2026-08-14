-- Dữ liệu nhận vào: activity Lesson 13 ở trạng thái draft và mapping đã duyệt của IC2200.
-- Việc chính: chỉ gán IC2200, đồng bộ roster công khai, đối chiếu số lượng với mapping rồi mới bật activity.
-- Kết quả: học viên IC2200 nhìn thấy handout; trình duyệt không nhận ID ERP, email hoặc Google ID.
-- Khi lỗi: transaction rollback toàn bộ, activity vẫn chưa được phát hành.
BEGIN;

DO $preflight$
DECLARE
  v_activity_count INTEGER;
BEGIN
  SELECT count(*) INTO v_activity_count
  FROM writing_practice.activity
  WHERE slug = 'writing-lesson13-young-leaders'
    AND content_version = '2026-08-14.1'
    AND grading_pool = 'lesson13'
    AND status IN ('draft', 'active');

  IF v_activity_count <> 1 THEN
    RAISE EXCEPTION 'Không tìm thấy duy nhất activity Lesson 13 hợp lệ.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM mapping.classroom_course_mapping
    WHERE erp_course_class_id = 1187
      AND lower(erp_class_name_snapshot) = 'ic2200'
      AND status = 'approved'
  ) THEN
    RAISE EXCEPTION 'Mapping IC2200 chưa ở trạng thái approved.';
  END IF;
END $preflight$;

WITH target AS (
  SELECT id FROM writing_practice.activity
  WHERE slug = 'writing-lesson13-young-leaders'
    AND content_version = '2026-08-14.1'
)
INSERT INTO writing_practice.activity_class_scope(
  activity_id, erp_course_class_id, class_name_snapshot, end_date, status
)
SELECT target.id, 1187, 'IC2200', DATE '2026-12-31', 'active'
FROM target
ON CONFLICT(activity_id, erp_course_class_id) DO UPDATE SET
  class_name_snapshot = EXCLUDED.class_name_snapshot,
  end_date = EXCLUDED.end_date,
  status = EXCLUDED.status;

SELECT writing_practice.refresh_activity_roster(id)
FROM writing_practice.activity
WHERE slug = 'writing-lesson13-young-leaders'
  AND content_version = '2026-08-14.1';

DO $validation$
DECLARE
  v_activity_id BIGINT;
  v_class RECORD;
  v_expected INTEGER;
  v_materialized INTEGER;
BEGIN
  SELECT id INTO STRICT v_activity_id
  FROM writing_practice.activity
  WHERE slug = 'writing-lesson13-young-leaders'
    AND content_version = '2026-08-14.1';

  FOR v_class IN
    SELECT scope.id, scope.erp_course_class_id, scope.class_name_snapshot
    FROM writing_practice.activity_class_scope scope
    WHERE scope.activity_id = v_activity_id
      AND scope.erp_course_class_id = 1187
      AND scope.status = 'active'
  LOOP
    SELECT count(DISTINCT review.public_id) INTO v_expected
    FROM mapping.classroom_course_mapping course
    JOIN mapping.classroom_roster_snapshot classroom
      ON classroom.classroom_course_id = course.classroom_course_id
      AND classroom.roster_state = 'active'
    JOIN mapping.student_mapping_review review
      ON review.erp_course_class_id = course.erp_course_class_id
      AND review.classroom_user_id = classroom.classroom_user_id
      AND review.status = 'approved'
    WHERE course.erp_course_class_id = v_class.erp_course_class_id
      AND course.status = 'approved';

    SELECT count(*) INTO v_materialized
    FROM writing_practice.activity_roster roster
    WHERE roster.activity_class_id = v_class.id AND roster.active;

    IF v_expected = 0 OR v_materialized <> v_expected THEN
      RAISE EXCEPTION 'Roster % không khớp mapping: expected %, materialized %.',
        v_class.class_name_snapshot, v_expected, v_materialized;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM writing_practice.activity_class_scope
      WHERE activity_id = v_activity_id AND status = 'active') <> 1
    OR NOT EXISTS (
      SELECT 1 FROM writing_practice.activity_class_scope
      WHERE activity_id = v_activity_id
        AND erp_course_class_id = 1187
        AND status = 'active'
    ) THEN
    RAISE EXCEPTION 'Activity phải chỉ được gán cho IC2200.';
  END IF;
END $validation$;

UPDATE writing_practice.activity
SET status = 'active', end_date = DATE '2026-12-31', updated_at = now()
WHERE slug = 'writing-lesson13-young-leaders'
  AND content_version = '2026-08-14.1';

COMMIT;
