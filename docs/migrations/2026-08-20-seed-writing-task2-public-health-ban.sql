-- Dữ liệu nhận vào: manifest Task 2 dùng chung và đề public-health do giảng viên cung cấp.
-- Việc chính: tạo một activity ở trạng thái bản nháp và bốn bước dùng cùng bộ prompt Task 2 tổng quát.
-- Kết quả: đổi sang đề khác chỉ cần thêm record cấu hình tương tự; không sao chép hoặc sửa web app.
-- Khi lỗi: transaction rollback toàn bộ; học viên không nhìn thấy hoạt động chưa hoàn chỉnh.
BEGIN;

INSERT INTO writing_practice.activity(
  public_id,slug,content_version,manifest_checksum,title,task_prompt,
  prompt_registry_key,prompt_record_ref,prompt_version,grading_pool,status,end_date
)
VALUES(
  '8905a155-18e9-4e3d-b3e9-f8e523e24466',
  'writing-task2-public-health-ban',
  '2026-08-20.1',
  '1b46158ec11751ff6ef977a47f7d8661e8a0ed5866a633b8738731601330eab7',
  'Luyện Writing Task 2: Public health',
  'Shops should be banned from selling any food or drink that has been scientifically proven to be damaging to public health. Do you agree or disagree?',
  'ielts:writing:task2:web:prompt_registry:v1',
  'task2-web-template-v1',
  '2026-08-19.1',
  'task2',
  'draft',
  DATE '2026-12-31'
)
ON CONFLICT(slug,content_version) DO UPDATE SET
  public_id=EXCLUDED.public_id,
  manifest_checksum=EXCLUDED.manifest_checksum,
  title=EXCLUDED.title,
  task_prompt=EXCLUDED.task_prompt,
  prompt_registry_key=EXCLUDED.prompt_registry_key,
  prompt_record_ref=EXCLUDED.prompt_record_ref,
  prompt_version=EXCLUDED.prompt_version,
  grading_pool=EXCLUDED.grading_pool,
  status='draft',
  end_date=EXCLUDED.end_date,
  updated_at=now();

WITH activity AS (
  SELECT id FROM writing_practice.activity
  WHERE slug='writing-task2-public-health-ban' AND content_version='2026-08-20.1'
), definitions(
  section_key,title,sort_order,input_fields,context_fields,required_fields,
  prerequisite_sections,validation_mode
) AS (
  VALUES
    ('topic_sentence','Chọn thân bài và viết Topic Sentence',1,
      '["body1_message","body1_idea1","body1_idea2","body2_message","body2_idea1","body2_idea2","body_choice","topic_sentence"]'::jsonb,
      '[]'::jsonb,
      '["body1_message","body1_idea1","body1_idea2","body2_message","body2_idea1","body2_idea2","body_choice","topic_sentence"]'::jsonb,
      '[]'::jsonb,'all'),
    ('supporting_idea_1','Phát triển Supporting Idea 1',2,
      '["idea1_a","idea1_x","idea1_b"]'::jsonb,
      '["body1_message","body1_idea1","body1_idea2","body2_message","body2_idea1","body2_idea2","body_choice","topic_sentence"]'::jsonb,
      '["idea1_a","idea1_x","idea1_b"]'::jsonb,
      '["topic_sentence"]'::jsonb,'all'),
    ('supporting_idea_2','Phát triển Supporting Idea 2 và tạo từ vựng',3,
      '["idea2_a","idea2_x","idea2_b"]'::jsonb,
      '["body1_message","body1_idea1","body1_idea2","body2_message","body2_idea1","body2_idea2","body_choice","topic_sentence","idea1_a","idea1_x","idea1_b"]'::jsonb,
      '["idea2_a","idea2_x","idea2_b"]'::jsonb,
      '["topic_sentence","supporting_idea_1"]'::jsonb,'all'),
    ('draft','Viết Draft 1, sửa Draft 2 và chấm từng câu',4,
      '["draft1","draft2"]'::jsonb,
      '["body1_message","body1_idea1","body1_idea2","body2_message","body2_idea1","body2_idea2","body_choice","topic_sentence","idea1_a","idea1_x","idea1_b","idea2_a","idea2_x","idea2_b"]'::jsonb,
      '["draft1","draft2"]'::jsonb,
      '["topic_sentence","supporting_idea_1","supporting_idea_2"]'::jsonb,'all')
)
INSERT INTO writing_practice.activity_section_definition(
  activity_id,section_key,title,sort_order,input_fields,context_fields,
  required_fields,prerequisite_sections,validation_mode,prompt_record_ref,prompt_version
)
SELECT activity.id,definitions.section_key,definitions.title,definitions.sort_order,
  definitions.input_fields,definitions.context_fields,definitions.required_fields,
  definitions.prerequisite_sections,definitions.validation_mode,
  'task2-web-template-v1','2026-08-19.1'
FROM activity CROSS JOIN definitions
ON CONFLICT(activity_id,section_key) DO UPDATE SET
  title=EXCLUDED.title,
  sort_order=EXCLUDED.sort_order,
  input_fields=EXCLUDED.input_fields,
  context_fields=EXCLUDED.context_fields,
  required_fields=EXCLUDED.required_fields,
  prerequisite_sections=EXCLUDED.prerequisite_sections,
  validation_mode=EXCLUDED.validation_mode,
  prompt_record_ref=EXCLUDED.prompt_record_ref,
  prompt_version=EXCLUDED.prompt_version,
  updated_at=now();

DO $validation$
DECLARE
  v_activity_count INTEGER;
  v_section_count INTEGER;
BEGIN
  SELECT count(*) INTO v_activity_count
  FROM writing_practice.activity
  WHERE slug='writing-task2-public-health-ban'
    AND content_version='2026-08-20.1'
    AND task_prompt='Shops should be banned from selling any food or drink that has been scientifically proven to be damaging to public health. Do you agree or disagree?'
    AND prompt_record_ref='task2-web-template-v1'
    AND status='draft';

  SELECT count(*) INTO v_section_count
  FROM writing_practice.activity_section_definition definition
  JOIN writing_practice.activity activity ON activity.id=definition.activity_id
  WHERE activity.slug='writing-task2-public-health-ban'
    AND definition.prompt_record_ref='task2-web-template-v1';

  IF v_activity_count<>1 OR v_section_count<>4 THEN
    RAISE EXCEPTION 'Cấu hình Task 2 chưa đủ: activity=%, sections=%.',v_activity_count,v_section_count;
  END IF;
END
$validation$;

COMMIT;
