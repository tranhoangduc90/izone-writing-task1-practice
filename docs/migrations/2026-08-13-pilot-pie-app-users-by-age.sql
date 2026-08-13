-- Dữ liệu nhận vào: migration writing_practice đã áp dụng và mapping IC2200 đã được duyệt.
-- Việc chính: tạo hoạt động public, gắn lớp IC2200 và materialize roster đã duyệt.
-- Kết quả: chỉ UUID công khai/tên hiển thị được dùng bởi API; không trả email hoặc mã ERP.
-- Khi lỗi: transaction rollback toàn bộ; roster phải đúng 14 học viên mới cho phép commit.
BEGIN;

INSERT INTO writing_practice.activity (
  public_id,
  slug,
  content_version,
  manifest_checksum,
  title,
  task_prompt,
  prompt_record_ref,
  prompt_version,
  status,
  end_date
)
VALUES (
  '41ec3339-edb5-4b13-8324-064deed6ca63',
  'pie-app-users-by-age',
  'task1-web-activity-v1',
  'ed08ea05927f56a33a7025a7a1bd568dba37aa03472d31765f61e25d4171e886',
  'Luyện Task 1: Độ tuổi người dùng ba ứng dụng',
  'The pie charts show the proportion of users across different age groups on three apps:Twitter, Facebook and YouTube.',
  'recvqPmgd9l5P1',
  '1',
  'active',
  DATE '2026-12-31'
)
ON CONFLICT (slug, content_version) DO UPDATE
SET public_id = EXCLUDED.public_id,
    manifest_checksum = EXCLUDED.manifest_checksum,
    title = EXCLUDED.title,
    task_prompt = EXCLUDED.task_prompt,
    prompt_record_ref = EXCLUDED.prompt_record_ref,
    prompt_version = EXCLUDED.prompt_version,
    status = EXCLUDED.status,
    end_date = EXCLUDED.end_date,
    updated_at = now();

INSERT INTO writing_practice.activity_class_scope (
  activity_id,
  erp_course_class_id,
  class_name_snapshot,
  end_date,
  status
)
SELECT id, 1187, 'IC2200', DATE '2026-12-31', 'active'
FROM writing_practice.activity
WHERE slug = 'pie-app-users-by-age' AND status = 'active'
ON CONFLICT (activity_id, erp_course_class_id) DO UPDATE
SET class_name_snapshot = EXCLUDED.class_name_snapshot,
    end_date = EXCLUDED.end_date,
    status = EXCLUDED.status;

SELECT writing_practice.refresh_activity_roster(id)
FROM writing_practice.activity
WHERE slug = 'pie-app-users-by-age' AND status = 'active';

DO $validation$
DECLARE
  v_roster_count INTEGER;
BEGIN
  SELECT count(*) INTO v_roster_count
  FROM writing_practice.activity_roster roster
  JOIN writing_practice.activity_class_scope scope ON scope.id = roster.activity_class_id
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'pie-app-users-by-age'
    AND scope.erp_course_class_id = 1187
    AND roster.active;

  IF v_roster_count <> 14 THEN
    RAISE EXCEPTION 'Pilot roster phải có 14 học viên đã duyệt, hiện có %.', v_roster_count;
  END IF;
END
$validation$;

COMMIT;
