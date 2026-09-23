-- Nhận vào: bài Test của lô đọc lại đã dừng vì bộ chọn TR/CC Homework cũ.
-- Việc chính: ghi sổ và yêu cầu chạy lại đúng bước kiểm, qua hàng bàn giao bền.
-- Kết quả: mỗi bài có một lệnh retry; không chấm lại bài đã giao.
-- Khi lỗi: transaction rollback, không còn trạng thái retry dang dở.
-- Cách chạy: psql -v batch_limit=1 -v task_type=task_1 -f <file>.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));

CREATE TABLE IF NOT EXISTS writing_flow.test_precheck_retry_audit (
  review_id uuid PRIMARY KEY REFERENCES writing_flow.manual_review(review_id),
  pair_id uuid NOT NULL REFERENCES writing_flow.pair(pair_id),
  retry_command_key uuid NOT NULL UNIQUE,
  prior_error_code text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON writing_flow.test_precheck_retry_audit FROM PUBLIC;

WITH selected AS (
  SELECT r.review_id,r.pair_id,r.stage_key,r.error_code,
    gen_random_uuid() AS request_id
  FROM writing_flow.manual_review AS r
  JOIN writing_flow.stage_result AS stage
    ON stage.pair_id=r.pair_id AND stage.stage_key=r.stage_key
  JOIN writing_flow.pair AS pair ON pair.pair_id=r.pair_id
  JOIN writing_flow.test_source_requeue_audit AS source_audit
    ON source_audit.source_id=pair.source_id
  WHERE r.status='open' AND r.stage_key='precheck'
    AND r.error_code='PRECHECK_FAILED'
    AND stage.status='needs_review' AND stage.cycle_no=r.cycle_no
    AND stage.attempt_count=3 AND pair.status='needs_review'
    AND (:'task_type'='any' OR pair.task_type=:'task_type')
    AND NOT EXISTS (
      SELECT 1 FROM writing_flow.test_precheck_retry_audit AS audit
      WHERE audit.review_id=r.review_id)
  ORDER BY r.opened_at,r.review_id
  LIMIT :batch_limit
  FOR UPDATE OF r,stage,pair SKIP LOCKED
), audited AS (
  INSERT INTO writing_flow.test_precheck_retry_audit
    (review_id,pair_id,retry_command_key,prior_error_code)
  SELECT review_id,pair_id,request_id,error_code FROM selected
  ON CONFLICT (review_id) DO NOTHING
  RETURNING review_id,pair_id,retry_command_key
), requested AS (
  UPDATE writing_flow.manual_review AS review
  SET status='retry_requested',checked_at=now(),
    checked_by='writing-test-precheck-recovery',
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
