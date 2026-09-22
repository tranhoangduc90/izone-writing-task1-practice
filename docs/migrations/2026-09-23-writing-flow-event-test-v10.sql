-- Đầu vào: hàng việc Writing hiện hữu và nguồn bài Test mới từ Classroom hoặc nút thêm thủ công.
-- Việc chính: phân biệt Homework/Test, gom các Task cùng bài Test và phát tín hiệu kỹ thuật sau commit.
-- Kết quả: backend đánh thức n8n theo sự kiện; database vẫn giữ việc để phục hồi khi mất tín hiệu.
-- Khi lỗi: transaction hoàn tác; không đổi bài, điểm hay dữ liệu Lark Base.

BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));

ALTER TABLE writing_flow.source_record DROP CONSTRAINT IF EXISTS source_record_source_type_check;
ALTER TABLE writing_flow.source_record ADD CONSTRAINT source_record_source_type_check
  CHECK (source_type IN ('lark_homework','google_classroom','manual','legacy','term_test'));

CREATE TABLE IF NOT EXISTS writing_flow.test_group (
  test_group_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL UNIQUE REFERENCES writing_flow.source_record(source_id),
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 2 AND 200),
  test_config text CHECK (test_config IS NULL OR length(test_config) <= 120),
  topology text NOT NULL CHECK (topology IN ('task_2_only','task_1_and_task_2')),
  note text CHECK (note IS NULL OR length(note) <= 1000),
  evidence_status text NOT NULL DEFAULT 'pending'
    CHECK (evidence_status IN ('pending','already_graded','changed_after_grading','needs_review')),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','running','complete','needs_review','skipped')),
  created_by text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS writing_flow.test_pair (
  test_group_id uuid NOT NULL REFERENCES writing_flow.test_group(test_group_id) ON DELETE CASCADE,
  pair_id uuid NOT NULL UNIQUE REFERENCES writing_flow.pair(pair_id) ON DELETE CASCADE,
  task_number smallint NOT NULL CHECK (task_number IN (1,2)),
  historical_evidence jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(historical_evidence)='object'),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','graded','delivered','needs_review','skipped')),
  task_score numeric(3,1) CHECK (task_score IS NULL OR task_score BETWEEN 0 AND 9),
  component_count smallint NOT NULL DEFAULT 0 CHECK (component_count BETWEEN 0 AND 10),
  graded_at timestamptz,
  delivered_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (test_group_id,task_number)
);

CREATE TABLE IF NOT EXISTS writing_flow.test_criterion_result (
  pair_id uuid NOT NULL REFERENCES writing_flow.pair(pair_id) ON DELETE CASCADE,
  criterion_code text NOT NULL CHECK (criterion_code IN ('TA','TR','CC','LR','GRA')),
  band_score numeric(3,1) NOT NULL CHECK (band_score BETWEEN 0 AND 9),
  name text NOT NULL,
  feedback_ciphertext bytea NOT NULL,
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (pair_id,criterion_code)
);

CREATE TABLE IF NOT EXISTS writing_flow.test_component_result (
  pair_id uuid NOT NULL REFERENCES writing_flow.pair(pair_id) ON DELETE CASCADE,
  criterion_code text NOT NULL CHECK (criterion_code IN ('TA','TR','CC','LR','GRA')),
  component_code text NOT NULL,
  label text NOT NULL,
  summary_ciphertext bytea NOT NULL,
  feedback_ciphertext bytea NOT NULL,
  completed_at timestamptz NOT NULL,
  PRIMARY KEY (pair_id,component_code),
  FOREIGN KEY (pair_id,criterion_code)
    REFERENCES writing_flow.test_criterion_result(pair_id,criterion_code) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS writing_flow.test_final (
  test_group_id uuid PRIMARY KEY REFERENCES writing_flow.test_group(test_group_id) ON DELETE CASCADE,
  task_1_score numeric(3,1) CHECK (task_1_score IS NULL OR task_1_score BETWEEN 0 AND 9),
  task_2_score numeric(3,1) CHECK (task_2_score IS NULL OR task_2_score BETWEEN 0 AND 9),
  writing_score numeric(3,1) CHECK (writing_score IS NULL OR writing_score BETWEEN 0 AND 9),
  status text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','ready','needs_review')),
  ready_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS writing_flow.test_delivery (
  pair_id uuid NOT NULL REFERENCES writing_flow.pair(pair_id) ON DELETE CASCADE,
  destination text NOT NULL CHECK (destination IN ('google_docs','lms','portal')),
  status text NOT NULL CHECK (status IN ('pending','complete','failed','needs_review')),
  result_url text,
  readback_ok boolean NOT NULL DEFAULT false,
  error_code text,
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pair_id,destination)
);

CREATE INDEX IF NOT EXISTS writing_test_group_status_idx
  ON writing_flow.test_group (status,updated_at DESC,test_group_id);

ALTER TABLE writing_flow.operator_event DROP CONSTRAINT IF EXISTS operator_event_event_type_check;
ALTER TABLE writing_flow.operator_event ADD CONSTRAINT operator_event_event_type_check CHECK (event_type IN (
  'retry_requested','rerun_requested','skipped','restored','source_edited',
  'manual_source_added','manual_test_added','class_scan_requested','legacy_imported','legacy_promoted',
  'source_issue_skipped','source_issue_restored','class_mapping_changed',
  'trcc_repair_seeded','trcc_repair_completed','trcc_repair_failed'
));

CREATE OR REPLACE FUNCTION writing_flow.notify_work_ready() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,writing_flow AS $$
BEGIN
  PERFORM pg_notify('writing_flow_work_ready', json_build_object('kind',TG_ARGV[0])::text);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS writing_handoff_work_ready ON writing_flow.handoff;
CREATE TRIGGER writing_handoff_work_ready
AFTER INSERT OR UPDATE OF status,next_send_at ON writing_flow.handoff
FOR EACH ROW WHEN (NEW.status IN ('pending','sent'))
EXECUTE FUNCTION writing_flow.notify_work_ready('handoff');

DROP TRIGGER IF EXISTS writing_scan_item_work_ready ON writing_flow.scan_item;
CREATE TRIGGER writing_scan_item_work_ready
AFTER INSERT OR UPDATE OF status,next_send_at ON writing_flow.scan_item
FOR EACH ROW WHEN (NEW.status IN ('pending','partial','issue'))
EXECUTE FUNCTION writing_flow.notify_work_ready('source');

DROP TRIGGER IF EXISTS writing_source_work_ready ON writing_flow.source_record;
CREATE TRIGGER writing_source_work_ready
AFTER INSERT OR UPDATE OF dispatch_status,next_dispatch_at ON writing_flow.source_record
FOR EACH ROW WHEN (NEW.dispatch_status IN ('pending','sent'))
EXECUTE FUNCTION writing_flow.notify_work_ready('source');

DROP TRIGGER IF EXISTS writing_stage_lease_work_ready ON writing_flow.stage_result;
CREATE TRIGGER writing_stage_lease_work_ready
AFTER UPDATE OF status,lease_expires_at ON writing_flow.stage_result
FOR EACH ROW WHEN (NEW.status='running')
EXECUTE FUNCTION writing_flow.notify_work_ready('handoff');

REVOKE ALL ON writing_flow.test_group,writing_flow.test_pair,
  writing_flow.test_component_result,writing_flow.test_criterion_result,
  writing_flow.test_final,writing_flow.test_delivery FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON writing_flow.test_group,writing_flow.test_pair,
  writing_flow.test_component_result,writing_flow.test_criterion_result,
  writing_flow.test_final,writing_flow.test_delivery TO writing_practice_api;
GRANT EXECUTE ON FUNCTION writing_flow.notify_work_ready() TO writing_practice_api;

COMMIT;
