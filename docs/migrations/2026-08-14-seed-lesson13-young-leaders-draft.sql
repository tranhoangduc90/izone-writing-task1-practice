-- Dữ liệu nhận vào: migration mở rộng Lesson 13 đã được áp dụng.
-- Việc chính: tạo activity và sáu section ở trạng thái draft, chưa gán lớp và chưa thể mở cho học viên.
-- Kết quả: backend/staging có cấu hình đúng với manifest công khai; prompt thật vẫn nằm ngoài GitHub.
-- Khi lỗi: rollback toàn bộ. Trước production phải thay end_date theo lớp và gán class scope riêng.
BEGIN;

INSERT INTO writing_practice.activity(
  slug,content_version,manifest_checksum,title,task_prompt,
  prompt_registry_key,prompt_record_ref,prompt_version,grading_pool,status,end_date
)
VALUES(
  'writing-lesson13-young-leaders',
  '2026-08-14.1',
  'eb8b3e9e92c88162305dca92af818c16ad050d3373b1f353a97a873a00bdb249',
  'Lesson 13 · Lập luận cho hai thân bài',
  'Directors and managers of organisations are often older people. Some people say that it is better for younger people to be leaders. To what extent do you agree or disagree?',
  'ielts:writing:lesson13:web:v1',
  'lesson13-web-v1',
  '2026-08-14.1',
  'lesson13',
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
  updated_at=now();

WITH activity AS (
  SELECT id FROM writing_practice.activity
  WHERE slug='writing-lesson13-young-leaders' AND content_version='2026-08-14.1'
), definitions(section_key,title,sort_order,input_fields,context_fields,required_fields,validation_mode,prompt_record_ref) AS (
  VALUES
    ('body1_topic','Body 1 · Chốt idea và Topic Sentence',1,
      '["body1_idea1","body1_idea2","body1_topic"]'::jsonb,'[]'::jsonb,
      '["body1_idea1","body1_idea2","body1_topic"]'::jsonb,'all','lesson13-topic-sentence-v1'),
    ('body1_support1','Body 1 · Supporting Idea 1',2,
      '["body1_support1_a","body1_support1_x","body1_support1_b"]'::jsonb,
      '["body1_idea1","body1_topic"]'::jsonb,
      '["body1_support1_a","body1_support1_x","body1_support1_b"]'::jsonb,'all','lesson13-supporting-idea-v1'),
    ('body1_support2','Body 1 · Supporting Idea 2',3,
      '["body1_support2_a","body1_support2_x","body1_support2_b"]'::jsonb,
      '["body1_idea2","body1_topic","body1_support1_a","body1_support1_x","body1_support1_b"]'::jsonb,
      '["body1_support2_a","body1_support2_x","body1_support2_b"]'::jsonb,'all','lesson13-supporting-idea-v1'),
    ('body2_topic','Body 2 · Chốt idea và Topic Sentence',4,
      '["body2_idea1","body2_idea2","body2_topic"]'::jsonb,'[]'::jsonb,
      '["body2_idea1","body2_idea2","body2_topic"]'::jsonb,'all','lesson13-topic-sentence-v1'),
    ('body2_support1','Body 2 · Supporting Idea 1',5,
      '["body2_support1_a","body2_support1_x","body2_support1_b"]'::jsonb,
      '["body2_idea1","body2_topic"]'::jsonb,
      '["body2_support1_a","body2_support1_x","body2_support1_b"]'::jsonb,'all','lesson13-supporting-idea-v1'),
    ('body2_support2','Body 2 · Supporting Idea 2',6,
      '["body2_support2_a","body2_support2_x","body2_support2_b"]'::jsonb,
      '["body2_idea2","body2_topic","body2_support1_a","body2_support1_x","body2_support1_b"]'::jsonb,
      '["body2_support2_a","body2_support2_x","body2_support2_b"]'::jsonb,'all','lesson13-supporting-idea-v1')
)
INSERT INTO writing_practice.activity_section_definition(
  activity_id,section_key,title,sort_order,input_fields,context_fields,
  required_fields,validation_mode,prompt_record_ref,prompt_version
)
SELECT activity.id,definitions.section_key,definitions.title,definitions.sort_order,
  definitions.input_fields,definitions.context_fields,definitions.required_fields,
  definitions.validation_mode,definitions.prompt_record_ref,'2026-08-14.1'
FROM activity CROSS JOIN definitions
ON CONFLICT(activity_id,section_key) DO UPDATE SET
  title=EXCLUDED.title,
  sort_order=EXCLUDED.sort_order,
  input_fields=EXCLUDED.input_fields,
  context_fields=EXCLUDED.context_fields,
  required_fields=EXCLUDED.required_fields,
  validation_mode=EXCLUDED.validation_mode,
  prompt_record_ref=EXCLUDED.prompt_record_ref,
  prompt_version=EXCLUDED.prompt_version,
  updated_at=now();

COMMIT;
