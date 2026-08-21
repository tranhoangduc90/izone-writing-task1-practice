-- Dữ liệu nhận vào: manifest đề Living alone đã qua kiểm tra, activity Task 2 mẫu
-- đang chạy và roster 31 học viên của CS.070626 đã có trong hệ thống Writing.
-- Việc chính: tạo activity mới bằng cấu trúc Task 2 dùng chung, gắn lớp ERP 1184
-- và sao chép đúng roster đang hoạt động của CS.070626.
-- Kết quả: học viên thấy đề mới qua một URL riêng; không tạo HTML, JavaScript
-- hoặc workflow n8n mới.
-- Khi lỗi: transaction rollback toàn bộ; activity chưa hoàn chỉnh không xuất hiện.
BEGIN;

INSERT INTO writing_practice.activity(
  slug,
  content_version,
  manifest_checksum,
  title,
  task_prompt,
  prompt_registry_key,
  prompt_record_ref,
  prompt_version,
  grading_pool,
  status,
  end_date
)
VALUES(
  'writing-task2-living-alone-development',
  '2026-08-21.1',
  '4ae0118dc1db04d46b2c32b9b2f242caac020047976136e992b1f1414f023c30',
  'Luyện Writing Task 2: Living alone',
  'Nowadays, more and more people are choosing to live alone. Is this a positive or negative development?',
  'ielts:writing:task2:web:prompt_registry:v1',
  'task2-web-template-v1',
  '2026-08-19.1',
  'task2',
  'active',
  DATE '2026-12-31'
)
ON CONFLICT(slug, content_version) DO UPDATE
SET manifest_checksum = EXCLUDED.manifest_checksum,
    title = EXCLUDED.title,
    task_prompt = EXCLUDED.task_prompt,
    prompt_registry_key = EXCLUDED.prompt_registry_key,
    prompt_record_ref = EXCLUDED.prompt_record_ref,
    prompt_version = EXCLUDED.prompt_version,
    grading_pool = EXCLUDED.grading_pool,
    status = EXCLUDED.status,
    end_date = EXCLUDED.end_date,
    updated_at = now();

-- Sao chép bốn định nghĩa bước từ activity Task 2 đã kiểm thử production.
WITH target_activity AS (
  SELECT id
  FROM writing_practice.activity
  WHERE slug = 'writing-task2-living-alone-development'
    AND content_version = '2026-08-21.1'
), source_definitions AS (
  SELECT definition.*
  FROM writing_practice.activity_section_definition definition
  JOIN writing_practice.activity activity
    ON activity.id = definition.activity_id
  WHERE activity.slug = 'writing-task2-public-health-ban'
    AND activity.content_version = '2026-08-20.1'
)
INSERT INTO writing_practice.activity_section_definition(
  activity_id,
  section_key,
  title,
  sort_order,
  input_fields,
  context_fields,
  required_fields,
  prerequisite_sections,
  validation_mode,
  prompt_record_ref,
  prompt_version
)
SELECT
  target_activity.id,
  source.section_key,
  source.title,
  source.sort_order,
  source.input_fields,
  source.context_fields,
  source.required_fields,
  source.prerequisite_sections,
  source.validation_mode,
  source.prompt_record_ref,
  source.prompt_version
FROM target_activity
CROSS JOIN source_definitions source
ON CONFLICT(activity_id, section_key) DO UPDATE
SET title = EXCLUDED.title,
    sort_order = EXCLUDED.sort_order,
    input_fields = EXCLUDED.input_fields,
    context_fields = EXCLUDED.context_fields,
    required_fields = EXCLUDED.required_fields,
    prerequisite_sections = EXCLUDED.prerequisite_sections,
    validation_mode = EXCLUDED.validation_mode,
    prompt_record_ref = EXCLUDED.prompt_record_ref,
    prompt_version = EXCLUDED.prompt_version,
    updated_at = now();

INSERT INTO writing_practice.activity_class_scope(
  activity_id,
  erp_course_class_id,
  class_name_snapshot,
  end_date,
  status
)
SELECT
  id,
  1184,
  'CS.070626',
  DATE '2026-12-31',
  'active'
FROM writing_practice.activity
WHERE slug = 'writing-task2-living-alone-development'
  AND content_version = '2026-08-21.1'
  AND status = 'active'
ON CONFLICT(activity_id, erp_course_class_id) DO UPDATE
SET class_name_snapshot = EXCLUDED.class_name_snapshot,
    end_date = EXCLUDED.end_date,
    status = EXCLUDED.status;

-- Đánh dấu roster cũ của đúng activity là không hoạt động trước khi dựng lại.
UPDATE writing_practice.activity_roster roster
SET active = false,
    updated_at = now()
FROM writing_practice.activity_class_scope scope
JOIN writing_practice.activity activity ON activity.id = scope.activity_id
WHERE roster.activity_class_id = scope.id
  AND activity.slug = 'writing-task2-living-alone-development'
  AND scope.erp_course_class_id = 1184;

-- Dùng lại đúng danh sách công khai đã được lớp CS.070626 sử dụng ở activity trước.
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
FROM writing_practice.activity_class_scope target_scope
JOIN writing_practice.activity target_activity
  ON target_activity.id = target_scope.activity_id
JOIN writing_practice.activity source_activity
  ON source_activity.slug = 'australian-destinations-1999-2009'
JOIN writing_practice.activity_class_scope source_scope
  ON source_scope.activity_id = source_activity.id
  AND source_scope.erp_course_class_id = 1184
JOIN writing_practice.activity_roster source_roster
  ON source_roster.activity_class_id = source_scope.id
  AND source_roster.active
WHERE target_activity.slug = 'writing-task2-living-alone-development'
  AND target_scope.erp_course_class_id = 1184
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
  v_distinct_alias_count INTEGER;
BEGIN
  SELECT count(*)
  INTO v_activity_count
  FROM writing_practice.activity
  WHERE slug = 'writing-task2-living-alone-development'
    AND content_version = '2026-08-21.1'
    AND manifest_checksum = '4ae0118dc1db04d46b2c32b9b2f242caac020047976136e992b1f1414f023c30'
    AND task_prompt = 'Nowadays, more and more people are choosing to live alone. Is this a positive or negative development?'
    AND grading_pool = 'task2'
    AND status = 'active';

  SELECT count(*)
  INTO v_section_count
  FROM writing_practice.activity_section_definition definition
  JOIN writing_practice.activity activity
    ON activity.id = definition.activity_id
  WHERE activity.slug = 'writing-task2-living-alone-development';

  SELECT count(*)
  INTO v_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity
    ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-living-alone-development'
    AND scope.erp_course_class_id = 1184
    AND scope.class_name_snapshot = 'CS.070626'
    AND scope.status = 'active';

  SELECT count(*), count(DISTINCT roster.display_alias)
  INTO v_roster_count, v_distinct_alias_count
  FROM writing_practice.activity_roster roster
  JOIN writing_practice.activity_class_scope scope
    ON scope.id = roster.activity_class_id
  JOIN writing_practice.activity activity
    ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-living-alone-development'
    AND scope.erp_course_class_id = 1184
    AND roster.active;

  IF v_activity_count <> 1
     OR v_section_count <> 4
     OR v_scope_count <> 1
     OR v_roster_count <> 31
     OR v_distinct_alias_count <> 31 THEN
    RAISE EXCEPTION
      'Phát hành đề Living alone chưa đủ: activity=%, sections=%, scope=%, roster=%, aliases=%.',
      v_activity_count,
      v_section_count,
      v_scope_count,
      v_roster_count,
      v_distinct_alias_count;
  END IF;
END
$validation$;

COMMIT;
