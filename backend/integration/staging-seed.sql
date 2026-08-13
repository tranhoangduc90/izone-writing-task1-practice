-- Dữ liệu nhận vào: schema writing_practice đã được tạo bằng migration chính.
-- Việc chính: tạo một hoạt động, một lớp và 40 học viên hoàn toàn giả để kiểm thử staging.
-- Kết quả: API có roster công khai nhưng không chứa dữ liệu học viên thật.
-- Khi lỗi: transaction rollback toàn bộ; xem lỗi psql, không có dữ liệu dở dang.
BEGIN;

INSERT INTO mapping.classroom_course_mapping (
  erp_course_class_id,
  erp_class_name_snapshot,
  classroom_course_id,
  classroom_course_name_snapshot,
  status
)
VALUES (
  999999999,
  'Lớp thử nghiệm 40 học viên',
  'staging-course-1',
  'Lớp thử nghiệm 40 học viên',
  'approved'
)
ON CONFLICT (erp_course_class_id) DO UPDATE
SET classroom_course_id = EXCLUDED.classroom_course_id,
    classroom_course_name_snapshot = EXCLUDED.classroom_course_name_snapshot,
    status = 'approved',
    updated_at = now();

INSERT INTO mapping.classroom_roster_snapshot (
  classroom_course_id,
  classroom_user_id,
  classroom_name_snapshot,
  roster_state
)
SELECT 'staging-course-1',
       'staging-user-' || student_number,
       'Học viên thử nghiệm ' || lpad(student_number::text, 2, '0'),
       'active'
FROM generate_series(1, 40) AS student_number
ON CONFLICT (classroom_course_id, classroom_user_id) DO UPDATE
SET classroom_name_snapshot = EXCLUDED.classroom_name_snapshot,
    roster_state = 'active',
    seen_at = now();

INSERT INTO mapping.student_mapping_review (
  erp_course_class_id,
  erp_student_contact_id,
  erp_student_name_snapshot,
  classroom_course_id,
  classroom_user_id,
  classroom_name_snapshot,
  match_method,
  status,
  public_id
)
SELECT 999999999,
       990000000 + student_number,
       'Học viên thử nghiệm ' || lpad(student_number::text, 2, '0'),
       'staging-course-1',
       'staging-user-' || student_number,
       'Học viên thử nghiệm ' || lpad(student_number::text, 2, '0'),
       'manual',
       'approved',
       ('00000000-0000-4000-8000-' || lpad(student_number::text, 12, '0'))::uuid
FROM generate_series(1, 40) AS student_number
ON CONFLICT (erp_course_class_id, classroom_user_id) DO UPDATE
SET classroom_name_snapshot = EXCLUDED.classroom_name_snapshot,
    status = 'approved',
    public_id = EXCLUDED.public_id,
    updated_at = now();

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

SELECT writing_practice.refresh_activity_roster(id)
FROM writing_practice.activity
WHERE slug = 'staging-task-1' AND status = 'active';

COMMIT;
