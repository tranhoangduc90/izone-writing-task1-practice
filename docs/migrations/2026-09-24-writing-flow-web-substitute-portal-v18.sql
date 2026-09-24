-- Dữ liệu vào: bài Substitute 2 K56 của IC2264 đã chấm xong trong database chung.
-- Việc chính: tạo phiếu chờ ghi Portal bền; chưa ghi điểm ra Portal ở migration này.
-- Kết quả: mỗi bài có tối đa một phiếu, kể cả bài hoàn tất trước khi áp migration.
-- Khi lỗi: transaction rollback, không thay bài và điểm đang có.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));

CREATE TABLE IF NOT EXISTS writing_flow.web_substitute_portal_outbox (
  submission_id uuid PRIMARY KEY REFERENCES
    writing_flow.web_substitute_submission(submission_id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN (
    'pending', 'running', 'synced', 'needs_review'
  )),
  lease_token uuid,
  lease_expires_at timestamptz,
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_error_code text,
  portal_receipt_sha256 char(64) CHECK (
    portal_receipt_sha256 IS NULL OR portal_receipt_sha256 ~ '^[0-9a-f]{64}$'
  ),
  completed_lease_token uuid,
  portal_fields jsonb CHECK (
    portal_fields IS NULL OR jsonb_typeof(portal_fields) = 'object'
  ),
  synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT web_substitute_portal_lease_check CHECK (
    (status = 'running') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)
  ),
  CONSTRAINT web_substitute_portal_synced_check CHECK (
    (status = 'synced') =
      (portal_receipt_sha256 IS NOT NULL AND completed_lease_token IS NOT NULL
       AND portal_fields IS NOT NULL AND synced_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS web_substitute_portal_due_idx
  ON writing_flow.web_substitute_portal_outbox
  (next_attempt_at, created_at, submission_id)
  WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS web_substitute_portal_expired_idx
  ON writing_flow.web_substitute_portal_outbox
  (lease_expires_at, submission_id)
  WHERE status = 'running';

-- Bổ sung bài đã chấm trước migration, nhưng chỉ trong lớp/đề thí điểm.
INSERT INTO writing_flow.web_substitute_portal_outbox (submission_id)
SELECT s.submission_id
FROM writing_flow.web_substitute_submission AS s
JOIN writing_flow.web_substitute_attempt AS a ON a.attempt_id=s.attempt_id
WHERE a.test_slug='substitute-test-2-k56'
  AND a.erp_course_class_id=1252
  AND s.status IN ('completed', 'delivered')
ON CONFLICT (submission_id) DO NOTHING;

REVOKE ALL ON writing_flow.web_substitute_portal_outbox FROM PUBLIC;
GRANT SELECT, INSERT ON writing_flow.web_substitute_portal_outbox
  TO writing_practice_api;
GRANT UPDATE (status, lease_token, lease_expires_at, attempt_count,
  next_attempt_at, last_error_code, portal_receipt_sha256,
  completed_lease_token, portal_fields, synced_at, updated_at)
  ON writing_flow.web_substitute_portal_outbox TO writing_practice_api;

COMMIT;
