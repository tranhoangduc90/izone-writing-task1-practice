-- Dữ liệu nhận vào: activity đô thị đã được seed trong database staging.
-- Việc chính: chỉ trên writing_practice_staging, mở một lớp và một học viên giả
-- để chạy API/E2E mà không dùng dữ liệu học viên thật.
-- Kết quả: có thể kiểm tra toàn bộ web app trước cổng production.
-- Khi lỗi hoặc chạy nhầm database: transaction rollback và psql trả lỗi rõ ràng.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $database_guard$
BEGIN
  IF current_database() <> 'writing_practice_staging' THEN
    RAISE EXCEPTION
      'Migration QA chỉ được chạy trên writing_practice_staging; database hiện tại là %.',
      current_database();
  END IF;
END
$database_guard$;

UPDATE writing_practice.activity
SET status = 'active',
    updated_at = now()
WHERE slug = 'writing-task2-urban-crowding-traffic-congestion'
  AND content_version = '2026-09-04.1'
  AND manifest_checksum = '6c8c2ebe60f926429a31875e44eebb46630b70ba695495003e946b62b8671296'
  AND prompt_registry_key = 'ielts:writing:task2:web:prompt_registry:v1'
  AND prompt_record_ref = 'task2-web-template-v1'
  AND prompt_version = '2026-08-19.1'
  AND grading_pool = 'task2'
  AND status IN ('draft', 'active');

INSERT INTO writing_practice.activity_class_scope(
  public_id,
  activity_id,
  erp_course_class_id,
  class_name_snapshot,
  end_date,
  status
)
SELECT
  '9705cdf0-8367-4242-b9dd-0c700196210e',
  id,
  -4092026,
  'Kiểm thử nội bộ: đô thị đông đúc',
  DATE '2026-12-31',
  'active'
FROM writing_practice.activity
WHERE slug = 'writing-task2-urban-crowding-traffic-congestion'
  AND content_version = '2026-09-04.1'
  AND status = 'active'
ON CONFLICT(activity_id, erp_course_class_id) DO UPDATE
SET public_id = EXCLUDED.public_id,
    class_name_snapshot = EXCLUDED.class_name_snapshot,
    end_date = EXCLUDED.end_date,
    status = EXCLUDED.status;

INSERT INTO writing_practice.activity_roster(
  activity_class_id,
  student_public_id,
  display_name,
  display_alias,
  active
)
SELECT
  scope.id,
  'ed783239-688e-432d-92a8-be7c8d306ce9',
  'Học viên kiểm thử',
  'Học viên kiểm thử',
  true
FROM writing_practice.activity_class_scope scope
JOIN writing_practice.activity activity ON activity.id = scope.activity_id
WHERE activity.slug = 'writing-task2-urban-crowding-traffic-congestion'
  AND scope.erp_course_class_id = -4092026
ON CONFLICT(activity_class_id, student_public_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    display_alias = EXCLUDED.display_alias,
    active = true,
    updated_at = now();

DO $validation$
DECLARE
  v_activity_count INTEGER;
  v_section_count INTEGER;
  v_scope_count INTEGER;
  v_roster_count INTEGER;
BEGIN
  SELECT count(*)
  INTO v_activity_count
  FROM writing_practice.activity
  WHERE slug = 'writing-task2-urban-crowding-traffic-congestion'
    AND content_version = '2026-09-04.1'
    AND status = 'active';

  SELECT count(*)
  INTO v_section_count
  FROM writing_practice.activity_section_definition definition
  JOIN writing_practice.activity activity ON activity.id = definition.activity_id
  WHERE activity.slug = 'writing-task2-urban-crowding-traffic-congestion';

  SELECT count(*)
  INTO v_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-urban-crowding-traffic-congestion'
    AND scope.public_id = '9705cdf0-8367-4242-b9dd-0c700196210e'
    AND scope.erp_course_class_id = -4092026
    AND scope.class_name_snapshot = 'Kiểm thử nội bộ: đô thị đông đúc'
    AND scope.status = 'active';

  SELECT count(*)
  INTO v_roster_count
  FROM writing_practice.activity_roster roster
  JOIN writing_practice.activity_class_scope scope ON scope.id = roster.activity_class_id
  WHERE scope.public_id = '9705cdf0-8367-4242-b9dd-0c700196210e'
    AND roster.student_public_id = 'ed783239-688e-432d-92a8-be7c8d306ce9'
    AND roster.active;

  IF v_activity_count <> 1
     OR v_section_count <> 4
     OR v_scope_count <> 1
     OR v_roster_count <> 1 THEN
    RAISE EXCEPTION
      'Mở QA staging chưa đủ: activity=%, sections=%, scope=%, roster=%.',
      v_activity_count,
      v_section_count,
      v_scope_count,
      v_roster_count;
  END IF;
END
$validation$;

COMMIT;
