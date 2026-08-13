-- Dữ liệu nhận vào: schema writing_practice đã được tạo bằng migration chính.
-- Việc chính: tạo một hoạt động, một lớp và 40 học viên hoàn toàn giả để kiểm thử staging.
-- Kết quả: API có roster công khai nhưng không chứa dữ liệu học viên thật.
-- Khi lỗi: transaction rollback toàn bộ; xem lỗi psql, không có dữ liệu dở dang.
BEGIN;

INSERT INTO writing_practice.activity (
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
  'staging-task-1',
  'staging-v1',
  encode(digest('staging-task-1', 'sha256'), 'hex'),
  'Bài kiểm thử Writing Task 1',
  'Đây là đề giả chỉ dùng để kiểm thử hệ thống staging.',
  'staging-not-for-gemini',
  'staging-v1',
  'active',
  CURRENT_DATE + 30
)
ON CONFLICT (slug, content_version) DO UPDATE
SET title = EXCLUDED.title,
    task_prompt = EXCLUDED.task_prompt,
    status = 'active',
    end_date = EXCLUDED.end_date,
    updated_at = now();

INSERT INTO writing_practice.activity_class_scope (
  activity_id,
  erp_course_class_id,
  class_name_snapshot,
  end_date,
  status
)
SELECT id, 999999999, 'Lớp thử nghiệm 40 học viên', CURRENT_DATE + 30, 'active'
FROM writing_practice.activity
WHERE slug = 'staging-task-1' AND status = 'active'
ON CONFLICT (activity_id, erp_course_class_id) DO UPDATE
SET class_name_snapshot = EXCLUDED.class_name_snapshot,
    end_date = EXCLUDED.end_date,
    status = 'active';

INSERT INTO writing_practice.activity_roster (
  activity_class_id,
  student_public_id,
  display_name,
  display_alias,
  active
)
SELECT scope.id,
       ('00000000-0000-4000-8000-' || lpad(student_number::text, 12, '0'))::uuid,
       'Học viên thử nghiệm ' || lpad(student_number::text, 2, '0'),
       'Học viên thử nghiệm ' || lpad(student_number::text, 2, '0'),
       true
FROM writing_practice.activity_class_scope scope
JOIN writing_practice.activity activity ON activity.id = scope.activity_id
CROSS JOIN generate_series(1, 40) AS student_number
WHERE activity.slug = 'staging-task-1'
  AND activity.status = 'active'
  AND scope.erp_course_class_id = 999999999
ON CONFLICT (activity_class_id, student_public_id) DO UPDATE
SET display_name = EXCLUDED.display_name,
    display_alias = EXCLUDED.display_alias,
    active = true,
    updated_at = now();

COMMIT;
