-- Nhận vào: tối đa 20 file Test cũ từng bị lọc nhầm hoặc đòi Comment của GV.
-- Việc chính: ghi sổ cũ rồi đưa đúng file Docs vào hàng đọc lại sau khi code mới đã hoạt động.
-- Kết quả: mỗi lần chạy tối đa 20 file; chạy lặp đến khi trả requeued=0.
-- Khi lỗi: transaction rollback; không đụng bài đã giao, file sai MIME hay Lark Base.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));

CREATE TABLE IF NOT EXISTS writing_flow.test_source_requeue_audit (
  source_id uuid PRIMARY KEY REFERENCES writing_flow.source_record(source_id),
  old_dispatch_status text NOT NULL,
  old_error_code text,
  old_dispatch_count integer NOT NULL,
  requeued_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON writing_flow.test_source_requeue_audit FROM PUBLIC;

WITH eligible AS (
  SELECT source.source_id
  FROM writing_flow.source_record AS source
  WHERE source.source_app_id='google_classroom'
    AND source.source_type='term_test'
    AND position('test' in lower(coalesce(source.display_name,'')))>0
    AND source.dispatch_status IN ('needs_review','excluded')
    AND NOT EXISTS (SELECT 1 FROM writing_flow.test_source_requeue_audit AS audit
      WHERE audit.source_id=source.source_id)
    AND (
      source.last_error_code='TEACHER_COMMENT_ANCHOR_MISSING'
      OR (source.last_error_code IN ('NON_WRITING_TITLE','NOT_WRITING_COURSEWORK')
        AND source.file_url LIKE 'https://docs.google.com/document/%')
      OR (source.last_error_code='SOURCE_ISSUE'
        AND EXISTS (SELECT 1 FROM writing_flow.source_issue AS issue
          WHERE issue.source_app_id=source.source_app_id
            AND issue.source_table_id=source.source_table_id
            AND issue.source_record_id=source.source_record_id
            AND issue.homework_file_id IS NOT DISTINCT FROM source.homework_file_id
            AND issue.source_link_index=source.source_link_index
            AND issue.status='open'
            AND issue.reason_code='TEACHER_COMMENT_ANCHOR_MISSING')
        AND NOT EXISTS (SELECT 1 FROM writing_flow.source_issue AS issue
          WHERE issue.source_app_id=source.source_app_id
            AND issue.source_table_id=source.source_table_id
            AND issue.source_record_id=source.source_record_id
            AND issue.homework_file_id IS NOT DISTINCT FROM source.homework_file_id
            AND issue.source_link_index=source.source_link_index
            AND issue.status='open'
            AND issue.reason_code<>'TEACHER_COMMENT_ANCHOR_MISSING'))
    )
  ORDER BY source.source_id
  LIMIT 20 FOR UPDATE OF source SKIP LOCKED
), recorded AS (
  INSERT INTO writing_flow.test_source_requeue_audit
    (source_id,old_dispatch_status,old_error_code,old_dispatch_count)
  SELECT source.source_id,source.dispatch_status,source.last_error_code,
    source.dispatch_count
  FROM writing_flow.source_record AS source
  JOIN eligible ON eligible.source_id=source.source_id
  ON CONFLICT (source_id) DO NOTHING
  RETURNING source_id
), queued AS (
  UPDATE writing_flow.source_record AS source
  SET dispatch_status='pending',dispatch_count=0,next_dispatch_at=now(),
    last_error_code=NULL,updated_at=now()
  FROM recorded
  WHERE source.source_id=recorded.source_id
  RETURNING source.source_id
)
SELECT count(*) AS requeued FROM queued;

COMMIT;
