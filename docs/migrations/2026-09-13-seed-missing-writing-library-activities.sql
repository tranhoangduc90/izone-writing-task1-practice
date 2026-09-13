-- Dữ liệu nhận vào: ba manifest web đã qua validator và các record prompt hiện hành.
-- Việc chính: tạo hai activity Task 1 và một activity Task 2 ở trạng thái bản nháp;
-- riêng Task 2 sao chép đúng bốn định nghĩa section từ template dùng chung.
-- Kết quả: đủ cấu hình để kiểm tra trước khi mở cho lớp thật.
-- Khi lỗi: transaction rollback toàn bộ; xem lỗi validation trong kết quả psql.
BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $source_validation$
DECLARE
  v_template_count INTEGER;
  v_section_count INTEGER;
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

  SELECT count(*)
  INTO v_section_count
  FROM writing_practice.activity_section_definition definition
  JOIN writing_practice.activity activity ON activity.id = definition.activity_id
  WHERE activity.slug = 'writing-task2-practice-template'
    AND activity.content_version = '2026-08-19.1';

  IF v_template_count <> 1 OR v_section_count <> 4 THEN
    RAISE EXCEPTION 'Template Task 2 chưa đạt: activity=%, sections=%.', v_template_count, v_section_count;
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
VALUES
(
  'c501cd2d-71ef-4a48-95b2-98ba27a0a499',
  'australian-physical-activity-2010',
  'task1-web-activity-v1',
  'cc1f12ce7f38259e296de855920275fca4e60f80269c03676ddbc0986704e29c',
  'Luyện Task 1: Hoạt động thể chất ở Úc năm 2010',
  'The bar chart below shows the percentage of Australian men and women in different age groups who did regular physical activity in 2010.',
  'ielts:wt1:active_prompt_registry:v1',
  'recvqm6zY8Fpnm',
  '1',
  'task1',
  'draft',
  DATE '2026-12-31'
),
(
  '5e9a65cb-037e-42e1-933c-1b54d818478f',
  'new-zealand-employment-1993-2003',
  'task1-web-activity-v1',
  'f14464c1c67bf8bc69cb4bb20c3473606fa7ee5baf3a164c9b3f4ca66cb59f14',
  'Luyện Task 1: Việc làm ở New Zealand, 1993–2003',
  'The table below shows employment patterns for males and females in New Zealand in 1993 and 2003.',
  'ielts:wt1:active_prompt_registry:v1',
  'recvqm6A2JC2i3',
  '1',
  'task1',
  'draft',
  DATE '2026-12-31'
),
(
  '17624e0b-4131-430d-9e6d-5b53354cfc90',
  'writing-task2-crime-prevention-responsibility',
  '2026-09-13.1',
  '7bd8e53f3f8affab42ec740dc073c8195112b0b2c4583cb1f8f0272516f2d839',
  'Luyện Task 2: Trách nhiệm phòng chống tội phạm',
  'Some people think that the government should be responsible for crime prevention, while others believe that it is the responsibility of the individual to protect themselves. Discuss both views and give your opinion.',
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
  WHERE slug = 'writing-task2-crime-prevention-responsibility'
    AND content_version = '2026-09-13.1'
), source_definition AS (
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
CROSS JOIN source_definition source
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
  v_activity_count INTEGER;
  v_crime_section_count INTEGER;
  v_active_scope_count INTEGER;
BEGIN
  SELECT count(*)
  INTO v_activity_count
  FROM writing_practice.activity
  WHERE (slug, content_version) IN (
    ('australian-physical-activity-2010', 'task1-web-activity-v1'),
    ('new-zealand-employment-1993-2003', 'task1-web-activity-v1'),
    ('writing-task2-crime-prevention-responsibility', '2026-09-13.1')
  )
    AND status IN ('draft', 'active');

  SELECT count(*)
  INTO v_crime_section_count
  FROM writing_practice.activity_section_definition definition
  JOIN writing_practice.activity activity ON activity.id = definition.activity_id
  WHERE activity.slug = 'writing-task2-crime-prevention-responsibility'
    AND activity.content_version = '2026-09-13.1';

  SELECT count(*)
  INTO v_active_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug IN (
    'australian-physical-activity-2010',
    'new-zealand-employment-1993-2003',
    'writing-task2-crime-prevention-responsibility'
  )
    AND activity.status = 'draft'
    AND scope.status = 'active';

  IF v_activity_count <> 3 OR v_crime_section_count <> 4 OR v_active_scope_count <> 0 THEN
    RAISE EXCEPTION 'Seed thư viện chưa đạt: activities=%, crime sections=%, draft scopes=%.',
      v_activity_count, v_crime_section_count, v_active_scope_count;
  END IF;
END
$validation$;

COMMIT;
