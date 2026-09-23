-- Nhận vào: nguồn Classroom có tên bài tập chứa "test" và các cặp đã giao.
-- Việc chính: ghi sổ trước khi đổi nhãn Homework lịch sử thành Test.
-- Kết quả: dashboard thấy bài Test cũ đã giao; không tạo handoff, không gọi AI.
-- Khi lỗi: transaction rollback; hai bảng audit giữ loại dữ liệu trước khi đổi.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));

CREATE TABLE IF NOT EXISTS writing_flow.test_source_migration_audit (
  source_id uuid PRIMARY KEY REFERENCES writing_flow.source_record(source_id),
  old_source_type text NOT NULL,
  old_dispatch_status text NOT NULL,
  old_error_code text,
  migrated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS writing_flow.test_pair_migration_audit (
  pair_id uuid PRIMARY KEY REFERENCES writing_flow.pair(pair_id),
  old_source_type text NOT NULL,
  migrated_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON writing_flow.test_source_migration_audit,
  writing_flow.test_pair_migration_audit FROM PUBLIC;

INSERT INTO writing_flow.test_source_migration_audit
  (source_id,old_source_type,old_dispatch_status,old_error_code)
SELECT source_id,source_type,dispatch_status,last_error_code
FROM writing_flow.source_record
WHERE source_app_id='google_classroom' AND source_type='google_classroom'
  AND position('test' in lower(coalesce(display_name,'')))>0
ON CONFLICT (source_id) DO NOTHING;

UPDATE writing_flow.source_record
SET source_type='term_test',updated_at=now()
WHERE source_app_id='google_classroom' AND source_type='google_classroom'
  AND position('test' in lower(coalesce(display_name,'')))>0;

INSERT INTO writing_flow.test_pair_migration_audit (pair_id,old_source_type)
SELECT pair.pair_id,pair.source_type
FROM writing_flow.pair AS pair
JOIN writing_flow.source_record AS source ON source.source_id=pair.source_id
WHERE source.source_app_id='google_classroom' AND source.source_type='term_test'
  AND position('test' in lower(coalesce(source.display_name,'')))>0
  AND pair.source_type='google_classroom' AND pair.status='delivered'
ON CONFLICT (pair_id) DO NOTHING;

UPDATE writing_flow.pair AS pair
SET source_type='term_test',updated_at=now()
FROM writing_flow.source_record AS source
WHERE source.source_id=pair.source_id
  AND source.source_app_id='google_classroom' AND source.source_type='term_test'
  AND position('test' in lower(coalesce(source.display_name,'')))>0
  AND pair.source_type='google_classroom' AND pair.status='delivered';

COMMIT;
