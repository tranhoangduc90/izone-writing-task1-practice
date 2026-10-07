-- Nhận schema Reading/Listening; lưu đúng bộ chấm và phiên bản được duyệt.
-- Tài khoản API chỉ đọc danh mục; thay bộ chấm bằng migration/quản trị có readback.
BEGIN;
CREATE TABLE IF NOT EXISTS reading_listening67.assignment_catalog (
  assignment_code text PRIMARY KEY CHECK (assignment_code ~ '^67-(reading-0[1-6]|listening-0[1-5])$'),
  workflow_id text NOT NULL CHECK (workflow_id ~ '^[A-Za-z0-9_-]{1,80}$'),
  template_version text NOT NULL,
  grader_version text NOT NULL,
  source_sha256 text NOT NULL CHECK (source_sha256 ~ '^[a-f0-9]{64}$'),
  enabled boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON reading_listening67.assignment_catalog FROM PUBLIC;
GRANT SELECT ON reading_listening67.assignment_catalog TO reading_listening67_api;
COMMIT;
