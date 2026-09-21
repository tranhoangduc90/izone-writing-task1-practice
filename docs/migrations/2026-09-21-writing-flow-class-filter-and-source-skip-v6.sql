BEGIN;

-- Dữ liệu nhận vào: trạng thái lỗi nguồn do quản trị viên thao tác trên dashboard.
-- Việc chính: bổ sung thùng rác mềm cho lỗi nguồn và nối thao tác với nhật ký vận hành.
-- Kết quả: lỗi nguồn có thể bỏ qua, xem lại và khôi phục mà không ghi vào Lark Base.
-- Khi lỗi: transaction hoàn tác; dữ liệu bài chấm và lịch quét hiện tại giữ nguyên.

ALTER TABLE writing_flow.source_issue
  ADD COLUMN IF NOT EXISTS skipped_at timestamptz,
  ADD COLUMN IF NOT EXISTS skipped_by text,
  ADD COLUMN IF NOT EXISTS skip_reason text;

ALTER TABLE writing_flow.source_issue
  DROP CONSTRAINT IF EXISTS source_issue_status_check;
ALTER TABLE writing_flow.source_issue
  ADD CONSTRAINT source_issue_status_check
  CHECK (status IN ('open','resolved','skipped'));

ALTER TABLE writing_flow.operator_event
  ADD COLUMN IF NOT EXISTS source_issue_key char(64)
    REFERENCES writing_flow.source_issue(issue_key);

ALTER TABLE writing_flow.operator_event
  DROP CONSTRAINT IF EXISTS operator_event_event_type_check;
ALTER TABLE writing_flow.operator_event
  ADD CONSTRAINT operator_event_event_type_check
  CHECK (event_type IN (
    'retry_requested','rerun_requested','skipped','restored','source_edited',
    'manual_source_added','class_scan_requested','legacy_imported','legacy_promoted',
    'class_mapping_changed','source_issue_skipped','source_issue_restored'
  ));

ALTER TABLE writing_flow.operator_event
  DROP CONSTRAINT IF EXISTS operator_event_check;
ALTER TABLE writing_flow.operator_event
  ADD CONSTRAINT operator_event_check
  CHECK (pair_id IS NOT NULL OR source_id IS NOT NULL OR class_code IS NOT NULL
    OR source_issue_key IS NOT NULL);

CREATE INDEX IF NOT EXISTS writing_operator_event_source_issue_idx
  ON writing_flow.operator_event (source_issue_key,created_at,event_id)
  WHERE source_issue_key IS NOT NULL;

COMMIT;
