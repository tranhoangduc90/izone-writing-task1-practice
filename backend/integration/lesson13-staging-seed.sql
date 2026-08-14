-- Dữ liệu nhận vào: activity Lesson 13 draft và lớp staging 40 học viên giả.
-- Việc chính: gán riêng activity mới cho lớp giả, đồng bộ roster rồi bật activity trên staging.
-- Kết quả: có thể kiểm thử đầy đủ mà không dùng dữ liệu IC2200 thật.
-- Khi lỗi: transaction rollback toàn bộ và activity vẫn chưa được phát hành.
BEGIN;

INSERT INTO writing_practice.activity_class_scope(
  activity_id, erp_course_class_id, class_name_snapshot, end_date, status
)
SELECT id, 999999999, 'Lớp thử nghiệm 40 học viên', CURRENT_DATE + 30, 'active'
FROM writing_practice.activity
WHERE slug = 'writing-lesson13-young-leaders'
  AND content_version = '2026-08-14.1'
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
  v_count INTEGER;
BEGIN
  SELECT count(*) INTO v_count
  FROM writing_practice.activity_roster roster
  JOIN writing_practice.activity_class_scope scope ON scope.id = roster.activity_class_id
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-lesson13-young-leaders'
    AND scope.erp_course_class_id = 999999999
    AND roster.active;

  IF v_count <> 40 THEN
    RAISE EXCEPTION 'Roster Lesson 13 staging phải có 40 học viên giả, hiện có %.', v_count;
  END IF;
END $validation$;

UPDATE writing_practice.activity
SET status = 'active', end_date = CURRENT_DATE + 30, updated_at = now()
WHERE slug = 'writing-lesson13-young-leaders'
  AND content_version = '2026-08-14.1';

COMMIT;

