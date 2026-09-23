-- Nhận vào: file Test lịch sử đã đọc xong, chỉ sinh lỗi nguồn và không có cặp chấm.
-- Việc chính: giữ lỗi chi tiết trong source_issue và đóng trạng thái gửi của file.
-- Trả ra: số file chuyển sang Cần kiểm tra; không gọi AI hoặc sửa bài đã giao.
-- Khi thiếu bằng chứng lỗi hoặc còn bài đang chạy: không chọn file.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));

CREATE TABLE IF NOT EXISTS writing_flow.test_source_issue_closure_audit (
  source_id uuid PRIMARY KEY REFERENCES writing_flow.source_record(source_id),
  prior_dispatch_status text NOT NULL,
  issue_count integer NOT NULL,
  final_error_code text NOT NULL,
  closed_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON writing_flow.test_source_issue_closure_audit FROM PUBLIC;

WITH selected AS (
  SELECT source.source_id,source.dispatch_status,
    count(DISTINCT issue.issue_key)::integer AS issue_count,
    CASE WHEN count(DISTINCT issue.reason_code)=1 THEN min(issue.reason_code)
      ELSE 'SOURCE_ISSUE' END AS final_error_code
  FROM writing_flow.source_record AS source
  JOIN writing_flow.test_source_requeue_audit AS requeue USING(source_id)
  JOIN writing_flow.source_issue AS issue
    ON issue.source_app_id=source.source_app_id
   AND issue.source_table_id=source.source_table_id
   AND issue.source_record_id=source.source_record_id
   AND issue.homework_file_id IS NOT DISTINCT FROM source.homework_file_id
   AND issue.source_link_index=source.source_link_index
   AND issue.status='open'
  WHERE source.dispatch_status='sent'
    AND source.last_dispatched_at<now()-interval '2 minutes'
    AND NOT EXISTS (SELECT 1 FROM writing_flow.pair pair
      WHERE pair.source_id=source.source_id)
    AND NOT EXISTS (SELECT 1 FROM writing_flow.test_source_issue_closure_audit audit
      WHERE audit.source_id=source.source_id)
  GROUP BY source.source_id,source.dispatch_status
  ORDER BY source.source_id
  LIMIT :batch_limit
), audited AS (
  INSERT INTO writing_flow.test_source_issue_closure_audit
    (source_id,prior_dispatch_status,issue_count,final_error_code)
  SELECT source_id,dispatch_status,issue_count,final_error_code FROM selected
  ON CONFLICT (source_id) DO NOTHING
  RETURNING source_id,final_error_code
), closed AS (
  UPDATE writing_flow.source_record AS source
  SET dispatch_status='needs_review',next_dispatch_at=NULL,
    last_error_code=audit.final_error_code,updated_at=now()
  FROM audited AS audit
  WHERE source.source_id=audit.source_id AND source.dispatch_status='sent'
  RETURNING source.source_id
)
SELECT count(*) AS closed_with_source_issue FROM closed;

COMMIT;
