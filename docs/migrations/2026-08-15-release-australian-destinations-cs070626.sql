-- Dữ liệu nhận vào: record Lark 90 đã có Prompt Overview/Body và manifest web đã qua QA.
-- Việc chính: tạo hoạt động Task 1, gắn lớp CS.070626 và dùng Prompt Registry riêng để cô lập khỏi n8n production hiện có.
-- Kết quả: lớp xuất hiện ở màn hình đăng nhập; do chưa có mapping, học viên đăng ký hồ sơ tạm để làm bài ngay.
-- Khi lỗi: transaction rollback toàn bộ; không sửa workflow hoặc container n8n.
BEGIN;

INSERT INTO writing_practice.activity (
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
VALUES (
  'af14b76f-8dff-4ac1-a7eb-518496c25ca4',
  'australian-destinations-1999-2009',
  'task1-web-activity-v1',
  'dc18d27c008b221e995943af8e93d85f169c0ea6ab6e3910abc29a9040158f9a',
  'Luyện Task 1: Điểm đến của người Úc',
  'The table below gives information on the number of Australian people who visited the seven most popular destinations in 1999 and 2009.',
  'ielts:wt1:web:record:90:prompt_registry:v1',
  'recvs8H9ghfkdz',
  '1',
  'task1',
  'active',
  DATE '2026-12-31'
)
ON CONFLICT (slug, content_version) DO UPDATE
SET public_id = EXCLUDED.public_id,
    manifest_checksum = EXCLUDED.manifest_checksum,
    title = EXCLUDED.title,
    task_prompt = EXCLUDED.task_prompt,
    prompt_registry_key = EXCLUDED.prompt_registry_key,
    prompt_record_ref = EXCLUDED.prompt_record_ref,
    prompt_version = EXCLUDED.prompt_version,
    grading_pool = EXCLUDED.grading_pool,
    status = EXCLUDED.status,
    end_date = EXCLUDED.end_date,
    updated_at = now();

-- CS.070626 chưa xuất hiện trong mapping production ngày 2026-08-15.
-- ID âm được dành riêng tạm thời để không thể trùng ERP ID thật; khi mapping có ID chính thức sẽ migration lại scope này.
INSERT INTO writing_practice.activity_class_scope (
  activity_id,
  erp_course_class_id,
  class_name_snapshot,
  end_date,
  status
)
SELECT id, -70626, 'CS.070626', DATE '2026-12-31', 'active'
FROM writing_practice.activity
WHERE slug = 'australian-destinations-1999-2009' AND status = 'active'
ON CONFLICT (activity_id, erp_course_class_id) DO UPDATE
SET class_name_snapshot = EXCLUDED.class_name_snapshot,
    end_date = EXCLUDED.end_date,
    status = EXCLUDED.status;

SELECT writing_practice.refresh_activity_roster(id)
FROM writing_practice.activity
WHERE slug = 'australian-destinations-1999-2009' AND status = 'active';

DO $validation$
DECLARE
  v_activity_count INTEGER;
  v_scope_count INTEGER;
BEGIN
  SELECT count(*) INTO v_activity_count
  FROM writing_practice.activity
  WHERE slug = 'australian-destinations-1999-2009'
    AND public_id = 'af14b76f-8dff-4ac1-a7eb-518496c25ca4'
    AND manifest_checksum = 'dc18d27c008b221e995943af8e93d85f169c0ea6ab6e3910abc29a9040158f9a'
    AND prompt_registry_key = 'ielts:wt1:web:record:90:prompt_registry:v1'
    AND prompt_record_ref = 'recvs8H9ghfkdz'
    AND prompt_version = '1'
    AND status = 'active';

  SELECT count(*) INTO v_scope_count
  FROM writing_practice.activity_class_scope scope
  JOIN writing_practice.activity activity ON activity.id = scope.activity_id
  WHERE activity.slug = 'australian-destinations-1999-2009'
    AND scope.erp_course_class_id = -70626
    AND scope.class_name_snapshot = 'CS.070626'
    AND scope.status = 'active';

  IF v_activity_count <> 1 OR v_scope_count <> 1 THEN
    RAISE EXCEPTION 'Cấu hình hoạt động/lớp chưa đúng: activity=%, scope=%.', v_activity_count, v_scope_count;
  END IF;
END
$validation$;

COMMIT;
