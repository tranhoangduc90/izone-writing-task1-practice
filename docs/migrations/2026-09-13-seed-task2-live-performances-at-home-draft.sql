-- Dữ liệu nhận vào: manifest đề về biểu diễn trực tiếp đã qua validator và activity
-- mẫu Task 2 đang ghim đúng bộ prompt dùng chung.
-- Việc chính: tạo activity ở trạng thái bản nháp và sao chép đúng bốn định nghĩa
-- section từ template; chưa gắn lớp hoặc roster thật.
-- Kết quả: có cấu hình để kiểm thử an toàn trước khi học viên nhìn thấy đề.
-- Khi lỗi: transaction rollback toàn bộ; xem lỗi validation trong kết quả psql.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $source_validation$
DECLARE
  v_template_count INTEGER;
  v_section_count INTEGER;
  v_section_key_count INTEGER;
BEGIN
  SELECT count(*)
  INTO v_template_count
  FROM writing_practice.activity
  WHERE slug = 'writing-task2-practice-template'
    AND content_version = '2026-08-19.1'
    AND prompt_registry_key = 'ielts:writing:task2:web:prompt_registry:v1'
    AND prompt_record_ref = 'task2-web-template-v1'
    AND prompt_version = '2026-08-19.1'
    AND grading_pool = 'task2';

  SELECT count(*), count(DISTINCT definition.section_key)
  INTO v_section_count, v_section_key_count
  FROM writing_practice.activity_section_definition definition
  JOIN writing_practice.activity activity ON activity.id = definition.activity_id
  WHERE activity.slug = 'writing-task2-practice-template'
    AND activity.content_version = '2026-08-19.1'
    AND definition.section_key IN (
      'topic_sentence',
      'supporting_idea_1',
      'supporting_idea_2',
      'draft'
    )
    AND definition.prompt_record_ref = 'task2-web-template-v1'
    AND definition.prompt_version = '2026-08-19.1';

  IF v_template_count <> 1
     OR v_section_count <> 4
     OR v_section_key_count <> 4 THEN
    RAISE EXCEPTION
      'Template Task 2 chưa đủ hoặc pin prompt đã đổi: activity=%, sections=%, section keys=%.',
      v_template_count,
      v_section_count,
      v_section_key_count;
  END IF;
END
$source_validation$;

INSERT INTO writing_practice.activity(
  public_id,
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
  '2a885869-969f-4ecf-8e1f-10183e3d8d4e',
  'writing-task2-live-performances-at-home',
  '2026-09-13.1',
  'dc6e1c9564d706dcc6bf9f7033cf2205f8aab2c18b1b56c6b9231200a67fa2be',
  'Luyện Writing Task 2: Biểu diễn trực tiếp hay xem tại nhà',
  'In today’s world, it is no longer necessary to attend live performances such as shows or concerts, as watching them on television or on a computer at home is considered a better option. Do you agree or disagree with this opinion?',
  'ielts:writing:task2:web:prompt_registry:v1',
  'task2-web-template-v1',
  '2026-08-19.1',
  'task2',
  'draft',
  DATE '2026-12-31'
)
ON CONFLICT(slug, content_version) DO UPDATE
SET public_id = EXCLUDED.public_id,
    manifest_checksum = EXCLUDED.manifest_checksum,
    title = EXCLUDED.title,
    task_prompt = EXCLUDED.task_prompt,
    prompt_registry_key = EXCLUDED.prompt_registry_key,
    prompt_record_ref = EXCLUDED.prompt_record_ref,
    prompt_version = EXCLUDED.prompt_version,
    grading_pool = EXCLUDED.grading_pool,
    end_date = EXCLUDED.end_date,
    updated_at = now()
WHERE writing_practice.activity.status = 'draft';

WITH target_activity AS (
  SELECT id
  FROM writing_practice.activity
  WHERE slug = 'writing-task2-live-performances-at-home'
    AND content_version = '2026-09-13.1'
), source_definitions AS (
  SELECT definition.*
  FROM writing_practice.activity_section_definition definition
  JOIN writing_practice.activity activity ON activity.id = definition.activity_id
  WHERE activity.slug = 'writing-task2-practice-template'
    AND activity.content_version = '2026-08-19.1'
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
  target.id,
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
FROM target_activity target
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

DO $validation$
DECLARE
  v_activity_status TEXT;
  v_activity_count INTEGER;
  v_section_count INTEGER;
  v_definition_difference_count INTEGER;
  v_active_scope_count INTEGER;
BEGIN
  SELECT count(*), max(status)
  INTO v_activity_count, v_activity_status
  FROM writing_practice.activity
  WHERE slug = 'writing-task2-live-performances-at-home'
    AND content_version = '2026-09-13.1'
    AND public_id = '2a885869-969f-4ecf-8e1f-10183e3d8d4e'
    AND manifest_checksum = 'dc6e1c9564d706dcc6bf9f7033cf2205f8aab2c18b1b56c6b9231200a67fa2be'
    AND task_prompt = 'In today’s world, it is no longer necessary to attend live performances such as shows or concerts, as watching them on television or on a computer at home is considered a better option. Do you agree or disagree with this opinion?'
    AND prompt_registry_key = 'ielts:writing:task2:web:prompt_registry:v1'
    AND prompt_record_ref = 'task2-web-template-v1'
    AND prompt_version = '2026-08-19.1'
    AND grading_pool = 'task2'
    AND end_date = DATE '2026-12-31'
    AND status IN ('draft', 'active');

  SELECT count(*)
  INTO v_section_count
  FROM writing_practice.activity_section_definition definition
  JOIN writing_practice.activity activity ON activity.id = definition.activity_id
  WHERE activity.slug = 'writing-task2-live-performances-at-home'
    AND activity.content_version = '2026-09-13.1';

  WITH target_definition AS (
    SELECT
      definition.section_key,
      definition.title,
      definition.sort_order,
      definition.input_fields,
      definition.context_fields,
      definition.required_fields,
      definition.prerequisite_sections,
      definition.validation_mode,
      definition.prompt_record_ref,
      definition.prompt_version
    FROM writing_practice.activity_section_definition definition
    JOIN writing_practice.activity activity ON activity.id = definition.activity_id
    WHERE activity.slug = 'writing-task2-live-performances-at-home'
      AND activity.content_version = '2026-09-13.1'
  ), source_definition AS (
    SELECT
      definition.section_key,
      definition.title,
      definition.sort_order,
      definition.input_fields,
      definition.context_fields,
      definition.required_fields,
      definition.prerequisite_sections,
      definition.validation_mode,
      definition.prompt_record_ref,
      definition.prompt_version
    FROM writing_practice.activity_section_definition definition
    JOIN writing_practice.activity activity ON activity.id = definition.activity_id
    WHERE activity.slug = 'writing-task2-practice-template'
      AND activity.content_version = '2026-08-19.1'
  ), differences AS (
    (SELECT * FROM target_definition EXCEPT SELECT * FROM source_definition)
    UNION ALL
    (SELECT * FROM source_definition EXCEPT SELECT * FROM target_definition)
  )
  SELECT count(*) INTO v_definition_difference_count FROM differences;

  SELECT count(*)
  INTO v_active_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'writing-task2-live-performances-at-home'
    AND scope.status = 'active';

  IF v_activity_count <> 1
     OR v_section_count <> 4
     OR v_definition_difference_count <> 0
     OR (v_activity_status = 'draft' AND v_active_scope_count <> 0) THEN
    RAISE EXCEPTION
      'Seed đề biểu diễn trực tiếp chưa đạt: activity=%, status=%, sections=%, lệch định nghĩa=%, scope active=%.',
      v_activity_count,
      v_activity_status,
      v_section_count,
      v_definition_difference_count,
      v_active_scope_count;
  END IF;
END
$validation$;

COMMIT;
