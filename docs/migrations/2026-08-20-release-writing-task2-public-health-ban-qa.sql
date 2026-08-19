-- Dữ liệu nhận vào: activity public-health đã seed, API và workflow Task 2 đã qua kiểm thử.
-- Việc chính: mở activity cho một lớp kiểm thử nội bộ và một học viên giả, không dùng dữ liệu cá nhân.
-- Kết quả: toàn bộ hành trình production có thể chạy thật mà chưa ảnh hưởng lớp học thật.
-- Khi lỗi: transaction rollback toàn bộ; activity vẫn ở trạng thái trước khi chạy migration.
BEGIN;

UPDATE writing_practice.activity
SET status='active',updated_at=now()
WHERE slug='writing-task2-public-health-ban'
  AND content_version='2026-08-20.1'
  AND manifest_checksum='1b46158ec11751ff6ef977a47f7d8661e8a0ed5866a633b8738731601330eab7'
  AND prompt_registry_key='ielts:writing:task2:web:prompt_registry:v1'
  AND prompt_record_ref='task2-web-template-v1'
  AND prompt_version='2026-08-19.1';

INSERT INTO writing_practice.activity_class_scope(
  public_id,activity_id,erp_course_class_id,class_name_snapshot,end_date,status
)
SELECT
  '71823175-f987-4d69-8cd6-51abb7ec6566',id,-22082026,
  'Kiểm thử nội bộ Task 2',DATE '2026-12-31','active'
FROM writing_practice.activity
WHERE slug='writing-task2-public-health-ban'
  AND content_version='2026-08-20.1'
  AND status='active'
ON CONFLICT(activity_id,erp_course_class_id) DO UPDATE SET
  class_name_snapshot=EXCLUDED.class_name_snapshot,
  end_date=EXCLUDED.end_date,
  status=EXCLUDED.status;

INSERT INTO writing_practice.activity_roster(
  activity_class_id,student_public_id,display_name,display_alias,active
)
SELECT
  scope.id,
  '782c4f2f-17ce-48cb-85f5-ad879c1c3e48',
  'Học viên kiểm thử',
  'Học viên kiểm thử',
  true
FROM writing_practice.activity_class_scope scope
JOIN writing_practice.activity activity ON activity.id=scope.activity_id
WHERE activity.slug='writing-task2-public-health-ban'
  AND scope.erp_course_class_id=-22082026
ON CONFLICT(activity_class_id,student_public_id) DO UPDATE SET
  display_name=EXCLUDED.display_name,
  display_alias=EXCLUDED.display_alias,
  active=EXCLUDED.active,
  updated_at=now();

DO $validation$
DECLARE
  v_activity_count INTEGER;
  v_scope_count INTEGER;
  v_roster_count INTEGER;
BEGIN
  SELECT count(*) INTO v_activity_count FROM writing_practice.activity
  WHERE slug='writing-task2-public-health-ban' AND status='active';

  SELECT count(*) INTO v_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id=scope.activity_id
  WHERE activity.slug='writing-task2-public-health-ban'
    AND scope.public_id='71823175-f987-4d69-8cd6-51abb7ec6566'
    AND scope.status='active';

  SELECT count(*) INTO v_roster_count
  FROM writing_practice.activity_roster roster
  JOIN writing_practice.activity_class_scope scope ON scope.id=roster.activity_class_id
  WHERE scope.public_id='71823175-f987-4d69-8cd6-51abb7ec6566'
    AND roster.student_public_id='782c4f2f-17ce-48cb-85f5-ad879c1c3e48'
    AND roster.active;

  IF v_activity_count<>1 OR v_scope_count<>1 OR v_roster_count<>1 THEN
    RAISE EXCEPTION 'Mở hoạt động kiểm thử chưa đủ: activity=%, scope=%, roster=%.',
      v_activity_count,v_scope_count,v_roster_count;
  END IF;
END
$validation$;

COMMIT;
