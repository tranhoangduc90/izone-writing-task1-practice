BEGIN;

-- Dữ liệu nhận vào: các nguồn bài từ Lark cũ, Google Classroom và link thêm thủ công.
-- Việc chính: lưu metadata vận hành, hàng bàn giao bền và lịch sử thao tác mà không lưu bài viết dạng rõ.
-- Kết quả: dashboard xem được nguồn, retry, bỏ qua/khôi phục và nhập lịch sử mà không ghi Lark Base.
-- Khi lỗi: toàn bộ transaction hoàn tác; các bảng Writing hiện hữu và 110 bài đã giao giữ nguyên.

CREATE TABLE IF NOT EXISTS writing_flow.source_record (
  source_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type text NOT NULL CHECK (source_type IN ('lark_homework','google_classroom','manual','legacy')),
  source_app_id text NOT NULL,
  source_table_id text NOT NULL,
  source_record_id text NOT NULL,
  homework_file_id text,
  source_link_index integer NOT NULL DEFAULT 1 CHECK (source_link_index > 0),
  display_name text,
  class_code text,
  student_name text,
  teacher_names text[] NOT NULL DEFAULT ARRAY[]::text[],
  classroom_url text,
  file_url text,
  source_status text,
  source_created_at timestamptz,
  source_updated_at timestamptz,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
  dispatch_status text NOT NULL DEFAULT 'idle'
    CHECK (dispatch_status IN ('idle','pending','sent','acknowledged','needs_review','excluded')),
  dispatch_count integer NOT NULL DEFAULT 0 CHECK (dispatch_count >= 0),
  next_dispatch_at timestamptz,
  last_dispatched_at timestamptz,
  acknowledged_at timestamptz,
  last_error_code text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_app_id,source_table_id,source_record_id,homework_file_id,source_link_index)
);

CREATE INDEX IF NOT EXISTS writing_source_dispatch_idx
  ON writing_flow.source_record (next_dispatch_at,created_at,source_id)
  WHERE dispatch_status IN ('pending','sent');
CREATE INDEX IF NOT EXISTS writing_source_class_idx
  ON writing_flow.source_record (class_code,source_updated_at DESC,source_id);
CREATE INDEX IF NOT EXISTS writing_source_type_idx
  ON writing_flow.source_record (source_type,updated_at DESC,source_id);

CREATE TABLE IF NOT EXISTS writing_flow.class_registry (
  class_code text PRIMARY KEY,
  classroom_course_id text NOT NULL UNIQUE,
  classroom_name text,
  cohort text,
  teacher_names text[] NOT NULL DEFAULT ARRAY[]::text[],
  enabled boolean NOT NULL DEFAULT true,
  source_ref text NOT NULL DEFAULT 'lark_read_only',
  scan_status text NOT NULL DEFAULT 'pending'
    CHECK (scan_status IN ('pending','scanning','succeeded','failed','paused')),
  next_scan_at timestamptz NOT NULL DEFAULT now(),
  last_scan_at timestamptz,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS writing_class_scan_idx
  ON writing_flow.class_registry (next_scan_at,class_code)
  WHERE enabled AND scan_status IN ('pending','scanning','succeeded','failed');

ALTER TABLE writing_flow.pair
  ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'lark_homework',
  ADD COLUMN IF NOT EXISTS source_id uuid REFERENCES writing_flow.source_record(source_id),
  ADD COLUMN IF NOT EXISTS skipped_at timestamptz,
  ADD COLUMN IF NOT EXISTS skipped_by text,
  ADD COLUMN IF NOT EXISTS skip_reason text,
  ADD COLUMN IF NOT EXISTS skip_previous_status text,
  ADD COLUMN IF NOT EXISTS finished_at timestamptz;

CREATE INDEX IF NOT EXISTS writing_pair_stage_dashboard_idx
  ON writing_flow.pair (skipped_at,updated_at DESC,pair_id);
CREATE INDEX IF NOT EXISTS writing_pair_source_idx
  ON writing_flow.pair (source_id,pair_id);

INSERT INTO writing_flow.source_record
  (source_type,source_app_id,source_table_id,source_record_id,homework_file_id,
   source_link_index,class_code,file_url,source_status,source_updated_at,dispatch_status,
   acknowledged_at,created_at,updated_at)
SELECT DISTINCT ON (source_app_id,source_table_id,source_record_id,homework_file_id,source_link_index)
  'lark_homework',source_app_id,source_table_id,source_record_id,homework_file_id,
  source_link_index,class_code,
  CASE WHEN document_kind='google_docs'
    THEN 'https://docs.google.com/document/d/' || homework_file_id || '/edit'
    ELSE NULL END,
  NULL,source_modified_at, 'acknowledged',now(),created_at,updated_at
FROM writing_flow.pair
ORDER BY source_app_id,source_table_id,source_record_id,homework_file_id,
  source_link_index,updated_at DESC,pair_id DESC
ON CONFLICT (source_app_id,source_table_id,source_record_id,homework_file_id,source_link_index)
DO NOTHING;

UPDATE writing_flow.pair AS p
SET source_id=s.source_id
FROM writing_flow.source_record AS s
WHERE p.source_id IS NULL
  AND s.source_app_id=p.source_app_id AND s.source_table_id=p.source_table_id
  AND s.source_record_id=p.source_record_id AND s.homework_file_id=p.homework_file_id
  AND s.source_link_index=p.source_link_index;

CREATE TABLE IF NOT EXISTS writing_flow.operator_event (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pair_id uuid REFERENCES writing_flow.pair(pair_id),
  source_id uuid REFERENCES writing_flow.source_record(source_id),
  class_code text,
  event_type text NOT NULL CHECK (event_type IN (
    'retry_requested','rerun_requested','skipped','restored','source_edited',
    'manual_source_added','class_scan_requested','legacy_imported','legacy_promoted'
  )),
  actor_ref text NOT NULL,
  request_id uuid NOT NULL UNIQUE,
  reason text,
  before_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_state jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (pair_id IS NOT NULL OR source_id IS NOT NULL OR class_code IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS writing_operator_event_pair_idx
  ON writing_flow.operator_event (pair_id,created_at,event_id);
CREATE INDEX IF NOT EXISTS writing_operator_event_source_idx
  ON writing_flow.operator_event (source_id,created_at,event_id);

CREATE TABLE IF NOT EXISTS writing_flow.pair_source_version (
  version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pair_id uuid NOT NULL REFERENCES writing_flow.pair(pair_id),
  version_no integer NOT NULL CHECK (version_no > 0),
  source_sha256 char(64) NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_ciphertext bytea NOT NULL,
  change_reason text,
  changed_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pair_id,version_no)
);

CREATE TABLE IF NOT EXISTS writing_flow.legacy_record (
  legacy_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_app_id text NOT NULL,
  source_table_id text NOT NULL,
  source_record_id text NOT NULL,
  essay_slot integer CHECK (essay_slot BETWEEN 1 AND 4),
  class_code text,
  student_name text,
  teacher_name text,
  source_status text,
  created_at_source timestamptz,
  finished_at_source timestamptz,
  snapshot_sha256 char(64) NOT NULL CHECK (snapshot_sha256 ~ '^[0-9a-f]{64}$'),
  snapshot_ciphertext bytea NOT NULL,
  linked_pair_id uuid REFERENCES writing_flow.pair(pair_id),
  match_status text NOT NULL DEFAULT 'unmatched'
    CHECK (match_status IN ('unmatched','matched','ambiguous','promoted','ignored')),
  imported_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (source_app_id,source_table_id,source_record_id,essay_slot,snapshot_sha256)
);
CREATE INDEX IF NOT EXISTS writing_legacy_class_idx
  ON writing_flow.legacy_record (class_code,created_at_source DESC,legacy_id);
CREATE INDEX IF NOT EXISTS writing_legacy_match_idx
  ON writing_flow.legacy_record (match_status,imported_at,legacy_id);

GRANT SELECT,INSERT,UPDATE ON writing_flow.source_record TO writing_practice_api;
GRANT SELECT,INSERT,UPDATE ON writing_flow.class_registry TO writing_practice_api;
GRANT SELECT,INSERT ON writing_flow.operator_event TO writing_practice_api;
GRANT SELECT,INSERT ON writing_flow.pair_source_version TO writing_practice_api;
GRANT SELECT,INSERT,UPDATE ON writing_flow.legacy_record TO writing_practice_api;
GRANT SELECT,UPDATE ON writing_flow.pair TO writing_practice_api;

COMMIT;
