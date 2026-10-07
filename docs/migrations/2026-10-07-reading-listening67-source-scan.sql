-- Chống hai lượt đọc Classroom cùng chạy; lưu lỗi và tổng kết riêng trong database.
BEGIN;
CREATE TABLE IF NOT EXISTS reading_listening67.source_scan_run (
  execution_id text PRIMARY KEY,
  lease_token uuid NOT NULL,
  status text NOT NULL CHECK(status IN ('running','done','partial','failed')),
  lease_expires_at timestamptz NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS rl67_source_one_scan ON reading_listening67.source_scan_run((1)) WHERE status='running';
CREATE TABLE IF NOT EXISTS reading_listening67.source_scan_course (
  execution_id text NOT NULL REFERENCES reading_listening67.source_scan_run(execution_id),
  course_id text NOT NULL,
  status text NOT NULL CHECK(status IN ('done','failed')),
  error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(execution_id,course_id)
);
REVOKE ALL ON reading_listening67.source_scan_run,reading_listening67.source_scan_course FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON reading_listening67.source_scan_run,reading_listening67.source_scan_course TO reading_listening67_api;
COMMIT;
