-- Dữ liệu nhận vào: lỗi nguồn Classroom hiện có trong phạm vi lớp Writing đang vận hành.
-- Việc chính: đánh dấu đã loại khi tiêu đề rõ ràng thuộc kỹ năng khác hoặc MIME không được hỗ trợ.
-- Kết quả: giữ nguyên source_record để đối chiếu, ẩn lỗi khỏi dashboard và không tạo/xóa bài chấm.
-- Khi không chắc chắn hoặc nguồn đã có pair: không thay đổi, để người vận hành tiếp tục kiểm tra.

BEGIN;

WITH visible_open AS (
  SELECT source.source_id,source.display_name,issue.reason_code,
    lower(regexp_replace(trim(coalesce(source.display_name,'')),'[[:space:]]+',' ','g')) AS title
  FROM writing_flow.source_issue AS issue
  JOIN writing_flow.source_record AS source
    ON source.source_app_id=issue.source_app_id
   AND source.source_table_id=issue.source_table_id
   AND source.source_record_id=issue.source_record_id
   AND source.homework_file_id IS NOT DISTINCT FROM issue.homework_file_id
   AND source.source_link_index IS NOT DISTINCT FROM issue.source_link_index
  LEFT JOIN writing_flow.class_registry AS registry ON registry.class_code=source.class_code
  WHERE issue.status='open' AND source.source_type='google_classroom'
    AND registry.class_status IS DISTINCT FROM 'completed'
    AND (registry.class_code IS NULL OR coalesce(registry.eligibility_reason,'')
      <> ALL(ARRAY['excluded','excluded_ic_before_2065','excluded_ic_program']::text[]))
    AND NOT EXISTS (SELECT 1 FROM writing_flow.pair WHERE pair.source_id=source.source_id)
), classified AS (
  SELECT source_id,
    bool_or(title ~ '(writing|essay|task[[:space:]]*[12]|(^|[^a-z])wt[[:space:]]*[0-9]+|bổ[[:space:]]*trợ|bo[[:space:]]*tro|(^|[^a-z])bt[[:space:]]*[0-9]+)') AS writing_hint,
    bool_or(title ~ '(read|listen|speak|speakig|vocab|grammar|ngữ[[:space:]]*pháp|ngu[[:space:]]*phap|từ[[:space:]]*vựng|tu[[:space:]]*vung|dịch|dich|(^|[^a-z])(nghe|doc|noi)([^a-z]|$))') AS nonwriting_hint,
    bool_or(reason_code='FILE_TYPE_UNSUPPORTED') AS unsupported_mime
  FROM visible_open GROUP BY source_id
), candidates AS (
  SELECT source_id,CASE WHEN nonwriting_hint AND NOT writing_hint
    THEN 'NON_WRITING_TITLE' ELSE 'FILE_TYPE_UNSUPPORTED' END AS exclusion_code
  FROM classified
  WHERE nonwriting_hint AND NOT writing_hint OR unsupported_mime
), updated_sources AS (
  UPDATE writing_flow.source_record AS source
  SET dispatch_status='excluded',next_dispatch_at=NULL,last_error_code=candidate.exclusion_code,
      metadata=source.metadata || jsonb_build_object('writingFilter',jsonb_build_object(
        'version','writing-source-title-v1','reason',candidate.exclusion_code,
        'classifiedAt',to_jsonb(now()))),updated_at=now()
  FROM candidates AS candidate WHERE source.source_id=candidate.source_id
  RETURNING source.source_id
)
UPDATE writing_flow.source_issue AS issue
SET status='resolved',resolved_at=now(),last_seen_at=now()
FROM writing_flow.source_record AS source
JOIN updated_sources AS updated ON updated.source_id=source.source_id
WHERE issue.source_app_id=source.source_app_id
  AND issue.source_table_id=source.source_table_id
  AND issue.source_record_id=source.source_record_id
  AND issue.homework_file_id IS NOT DISTINCT FROM source.homework_file_id
  AND issue.source_link_index IS NOT DISTINCT FROM source.source_link_index
  AND issue.status='open';

COMMIT;
