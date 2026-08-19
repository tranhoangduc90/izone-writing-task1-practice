-- Dữ liệu nhận vào: schema handout linh hoạt đã có activity_section_definition và hàng đợi chấm chung.
-- Việc chính: thêm điều kiện mở khóa theo thứ tự và tạo một activity Task 2 ở trạng thái bản nháp.
-- Kết quả: web có bốn lượt Check riêng; activity chưa gán lớp, chưa dùng nội dung từ bài của học viên.
-- Khi lỗi: transaction rollback toàn bộ. Phải cấu hình đề và Prompt Registry trước khi mở cho lớp.
BEGIN;

ALTER TABLE writing_practice.activity_section_definition
  ADD COLUMN IF NOT EXISTS prerequisite_sections JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE writing_practice.activity_section_definition
  DROP CONSTRAINT IF EXISTS activity_section_definition_prerequisites_check;
ALTER TABLE writing_practice.activity_section_definition
  ADD CONSTRAINT activity_section_definition_prerequisites_check
  CHECK (jsonb_typeof(prerequisite_sections) = 'array') NOT VALID;
ALTER TABLE writing_practice.activity_section_definition
  VALIDATE CONSTRAINT activity_section_definition_prerequisites_check;

INSERT INTO writing_practice.activity(
  slug,content_version,manifest_checksum,title,task_prompt,
  prompt_registry_key,prompt_record_ref,prompt_version,grading_pool,status,end_date
)
VALUES(
  'writing-task2-practice-template',
  '2026-08-19.1',
  '73ba2a87d0edcdfd3dfd874b47c0a68bf17cd3d23263102dcb2ab8abdec7412b',
  'Luyện viết một đoạn thân bài Writing Task 2',
  '__CONFIGURE_TASK_PROMPT_BEFORE_RELEASE__',
  'ielts:writing:task2:web:prompt_registry:v1',
  'task2-web-template-v1',
  '2026-08-19.1',
  'task2',
  'draft',
  DATE '2026-12-31'
)
ON CONFLICT(slug,content_version) DO UPDATE SET
  manifest_checksum=EXCLUDED.manifest_checksum,
  title=EXCLUDED.title,
  task_prompt=EXCLUDED.task_prompt,
  prompt_registry_key=EXCLUDED.prompt_registry_key,
  prompt_record_ref=EXCLUDED.prompt_record_ref,
  prompt_version=EXCLUDED.prompt_version,
  grading_pool=EXCLUDED.grading_pool,
  status='draft',
  updated_at=now();

WITH activity AS (
  SELECT id FROM writing_practice.activity
  WHERE slug='writing-task2-practice-template' AND content_version='2026-08-19.1'
), definitions(
  section_key,title,sort_order,input_fields,context_fields,required_fields,
  prerequisite_sections,validation_mode,prompt_record_ref
) AS (
  VALUES
    ('topic_sentence','Chọn thân bài và viết Topic Sentence',1,
      '["body1_message","body1_idea1","body1_idea2","body2_message","body2_idea1","body2_idea2","body_choice","topic_sentence"]'::jsonb,
      '[]'::jsonb,
      '["body1_message","body1_idea1","body1_idea2","body2_message","body2_idea1","body2_idea2","body_choice","topic_sentence"]'::jsonb,
      '[]'::jsonb,'all','task2-web-template-v1'),
    ('supporting_idea_1','Phát triển Supporting Idea 1',2,
      '["idea1_a","idea1_x","idea1_b"]'::jsonb,
      '["body1_message","body1_idea1","body1_idea2","body2_message","body2_idea1","body2_idea2","body_choice","topic_sentence"]'::jsonb,
      '["idea1_a","idea1_x","idea1_b"]'::jsonb,
      '["topic_sentence"]'::jsonb,'all','task2-web-template-v1'),
    ('supporting_idea_2','Phát triển Supporting Idea 2 và tạo từ vựng',3,
      '["idea2_a","idea2_x","idea2_b"]'::jsonb,
      '["body1_message","body1_idea1","body1_idea2","body2_message","body2_idea1","body2_idea2","body_choice","topic_sentence","idea1_a","idea1_x","idea1_b"]'::jsonb,
      '["idea2_a","idea2_x","idea2_b"]'::jsonb,
      '["topic_sentence","supporting_idea_1"]'::jsonb,'all','task2-web-template-v1'),
    ('draft','Viết Draft 1, sửa Draft 2 và chấm từng câu',4,
      '["draft1","draft2"]'::jsonb,
      '["body1_message","body1_idea1","body1_idea2","body2_message","body2_idea1","body2_idea2","body_choice","topic_sentence","idea1_a","idea1_x","idea1_b","idea2_a","idea2_x","idea2_b"]'::jsonb,
      '["draft1","draft2"]'::jsonb,
      '["topic_sentence","supporting_idea_1","supporting_idea_2"]'::jsonb,'all','task2-web-template-v1')
)
INSERT INTO writing_practice.activity_section_definition(
  activity_id,section_key,title,sort_order,input_fields,context_fields,
  required_fields,prerequisite_sections,validation_mode,prompt_record_ref,prompt_version
)
SELECT activity.id,definitions.section_key,definitions.title,definitions.sort_order,
  definitions.input_fields,definitions.context_fields,definitions.required_fields,
  definitions.prerequisite_sections,definitions.validation_mode,
  definitions.prompt_record_ref,'2026-08-19.1'
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

COMMIT;
