-- Nhận vào: ba lượt giao Test bị quota chặn sau khi đã ghi đủ nhận xét.
-- Việc chính: chỉ cấp lại đúng bước giao nếu người vận hành đã đọc lại chữ và marker.
-- Trả ra: số bài được cấp lại; các bài lỗi quyền ghi không nằm trong danh sách.
-- Khi trạng thái đã đổi: không chọn bài, không ghi đè kết quả hay gọi AI.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));

CREATE TABLE IF NOT EXISTS writing_flow.test_complete_marker_retry_audit (
  review_id uuid PRIMARY KEY REFERENCES writing_flow.manual_review(review_id),
  pair_id uuid NOT NULL REFERENCES writing_flow.pair(pair_id),
  retry_command_key uuid NOT NULL UNIQUE,
  prior_execution_id text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON writing_flow.test_complete_marker_retry_audit FROM PUBLIC;

WITH selected AS (
  SELECT review.review_id,review.pair_id,review.stage_key,
    stage.n8n_execution_id,gen_random_uuid() AS request_id
  FROM writing_flow.manual_review AS review
  JOIN writing_flow.stage_result AS stage
    ON stage.pair_id=review.pair_id AND stage.stage_key=review.stage_key
  JOIN writing_flow.pair AS pair ON pair.pair_id=review.pair_id
  WHERE review.status='open' AND review.stage_key='deliver'
    AND review.error_code='DELIVERY_FAILED'
    AND stage.status='needs_review' AND stage.cycle_no=review.cycle_no
    AND stage.attempt_count=3 AND pair.status='needs_review'
    AND pair.source_type='term_test'
    AND stage.n8n_execution_id IN ('2326469','2326471','2326504')
    AND NOT EXISTS (SELECT 1 FROM writing_flow.test_complete_marker_retry_audit audit
      WHERE audit.review_id=review.review_id)
  ORDER BY review.opened_at,review.review_id
  LIMIT :batch_limit
  FOR UPDATE OF review,stage,pair SKIP LOCKED
), audited AS (
  INSERT INTO writing_flow.test_complete_marker_retry_audit
    (review_id,pair_id,retry_command_key,prior_execution_id)
  SELECT review_id,pair_id,request_id,n8n_execution_id FROM selected
  ON CONFLICT (review_id) DO NOTHING
  RETURNING review_id,pair_id,retry_command_key
), requested AS (
  UPDATE writing_flow.manual_review AS review
  SET status='retry_requested',checked_at=now(),
    checked_by='writing-test-complete-marker-recovery',
    retry_command_key=audit.retry_command_key,retry_requested_at=now()
  FROM audited AS audit
  WHERE review.review_id=audit.review_id
  RETURNING review.pair_id,review.stage_key,review.retry_command_key
), queued AS (
  INSERT INTO writing_flow.handoff
    (pair_id,from_stage,to_stage,source_result_sha256,status,next_send_at)
  SELECT pair_id,'review',stage_key,
    encode(digest(retry_command_key::text,'sha256'),'hex'),'pending',now()
  FROM requested
  RETURNING handoff_id
)
SELECT count(*) AS retry_requested FROM queued;

COMMIT;
