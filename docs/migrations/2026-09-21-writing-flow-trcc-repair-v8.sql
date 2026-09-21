BEGIN;

-- Dữ liệu nhận vào: các bài Classroom từng bị luồng nguồn đánh dấu nhầm là không cần TR/CC.
-- Việc chính: lưu hàng đợi cứu riêng, ba lượt thử và cờ hiệu lực mà không chấm lại toàn bài.
-- Kết quả: trang kết quả được tạo lại từ phản biện cũ cộng TR/CC mới, có nhật ký và retry.
-- Khi lỗi: transaction hoàn tác; không sửa bài, link Google Docs hoặc dữ liệu Lark Base.

ALTER TABLE writing_flow.pair
  ADD COLUMN IF NOT EXISTS trcc_required_override boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS writing_flow.trcc_repair (
  pair_id uuid PRIMARY KEY REFERENCES writing_flow.pair(pair_id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','succeeded','needs_review')),
  cycle_no integer NOT NULL DEFAULT 1 CHECK (cycle_no > 0),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  batch_request_id uuid NOT NULL,
  result_sha256 char(64) CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  result_ciphertext bytea,
  error_code text,
  started_at timestamptz,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((result_sha256 IS NULL) = (result_ciphertext IS NULL))
);

CREATE TABLE IF NOT EXISTS writing_flow.trcc_repair_attempt (
  repair_attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pair_id uuid NOT NULL REFERENCES writing_flow.trcc_repair(pair_id) ON DELETE CASCADE,
  cycle_no integer NOT NULL CHECK (cycle_no > 0),
  attempt_no integer NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  request_key uuid NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('sent','succeeded','failed','unknown','late')),
  n8n_execution_id text,
  result_sha256 char(64) CHECK (result_sha256 IS NULL OR result_sha256 ~ '^[0-9a-f]{64}$'),
  result_ciphertext bytea,
  error_code text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  UNIQUE (pair_id,cycle_no,attempt_no),
  CHECK ((result_sha256 IS NULL) = (result_ciphertext IS NULL))
);

CREATE INDEX IF NOT EXISTS writing_trcc_repair_queue_idx
  ON writing_flow.trcc_repair (status,updated_at,pair_id);

ALTER TABLE writing_flow.operator_event
  DROP CONSTRAINT IF EXISTS operator_event_event_type_check;
ALTER TABLE writing_flow.operator_event
  ADD CONSTRAINT operator_event_event_type_check
  CHECK (event_type IN (
    'retry_requested','rerun_requested','skipped','restored','source_edited',
    'manual_source_added','class_scan_requested','legacy_imported','legacy_promoted',
    'class_mapping_changed','source_issue_skipped','source_issue_restored',
    'trcc_repair_seeded','trcc_repair_completed','trcc_repair_failed'
  ));

GRANT SELECT,INSERT,UPDATE ON writing_flow.trcc_repair TO writing_practice_api;
GRANT SELECT,INSERT,UPDATE ON writing_flow.trcc_repair_attempt TO writing_practice_api;
GRANT SELECT,UPDATE (trcc_required_override) ON writing_flow.pair TO writing_practice_api;

COMMIT;
