-- Đầu vào: một cặp Test, dấu đầu vào của bước chấm chính và từng thành phần chuyên môn.
-- Việc chính: lưu lượt chạy, kết quả từng thành phần và một cổng tổng hợp có khóa chống trùng.
-- Kết quả: có thể tiếp tục từ thành phần còn thiếu mà không gọi lại phần đã chấm thành công.
-- Khi lỗi: transaction hoàn tác; các workflow hiện hành chưa sử dụng bảng mới nên không đổi hành vi.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));

CREATE TABLE IF NOT EXISTS writing_flow.test_component_work (
  pair_id uuid NOT NULL REFERENCES writing_flow.pair(pair_id) ON DELETE CASCADE,
  input_sha256 char(64) NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  component_code text NOT NULL CHECK (length(component_code) BETWEEN 2 AND 64),
  phase text NOT NULL CHECK (phase IN ('detail','criterion')),
  criterion_code text NOT NULL CHECK (criterion_code IN ('TA','TR','CC','LR','GRA')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','succeeded','needs_review')),
  retry_cycle integer NOT NULL DEFAULT 1 CHECK (retry_cycle >= 1),
  attempt_count smallint NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  selected_attempt_id uuid,
  result_sha256 char(64),
  result_ciphertext bytea,
  lease_expires_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pair_id,input_sha256,component_code),
  CHECK ((result_sha256 IS NULL) = (result_ciphertext IS NULL)),
  CHECK (status <> 'succeeded' OR (selected_attempt_id IS NOT NULL
    AND result_sha256 IS NOT NULL AND completed_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS writing_flow.test_component_attempt (
  attempt_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pair_id uuid NOT NULL,
  input_sha256 char(64) NOT NULL,
  component_code text NOT NULL,
  stage_attempt_id uuid NOT NULL REFERENCES writing_flow.stage_attempt(attempt_id),
  retry_cycle integer NOT NULL CHECK (retry_cycle >= 1),
  attempt_no smallint NOT NULL CHECK (attempt_no BETWEEN 1 AND 3),
  run_key uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'sent'
    CHECK (status IN ('sent','succeeded','failed','late','unknown')),
  error_code text,
  result_sha256 char(64),
  result_ciphertext bytea,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  FOREIGN KEY (pair_id,input_sha256,component_code)
    REFERENCES writing_flow.test_component_work(pair_id,input_sha256,component_code)
    ON DELETE CASCADE,
  UNIQUE (pair_id,input_sha256,component_code,retry_cycle,attempt_no),
  CHECK ((result_sha256 IS NULL) = (result_ciphertext IS NULL))
);

CREATE TABLE IF NOT EXISTS writing_flow.test_component_gate (
  pair_id uuid NOT NULL REFERENCES writing_flow.pair(pair_id) ON DELETE CASCADE,
  input_sha256 char(64) NOT NULL CHECK (input_sha256 ~ '^[0-9a-f]{64}$'),
  gate_name text NOT NULL CHECK (gate_name IN ('detail_complete','criterion_complete')),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN ('ready','claimed','complete')),
  created_at timestamptz NOT NULL DEFAULT now(),
  claimed_at timestamptz,
  completed_at timestamptz,
  PRIMARY KEY (pair_id,input_sha256,gate_name)
);

CREATE INDEX IF NOT EXISTS writing_test_component_due_idx
  ON writing_flow.test_component_work (status,lease_expires_at,updated_at)
  WHERE status IN ('pending','running');
CREATE INDEX IF NOT EXISTS writing_test_component_stage_attempt_idx
  ON writing_flow.test_component_attempt (stage_attempt_id,started_at DESC);

REVOKE ALL ON writing_flow.test_component_work,
  writing_flow.test_component_attempt,writing_flow.test_component_gate FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON writing_flow.test_component_work,
  writing_flow.test_component_attempt,writing_flow.test_component_gate TO writing_practice_api;

COMMIT;
