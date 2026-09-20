BEGIN;

-- Dữ liệu nhận vào: nhật ký thao tác Writing đã có và các lần đồng bộ lớp mới.
-- Việc chính: cho phép ghi riêng thay đổi trạng thái lớp từ database mapping.
-- Kết quả: dashboard đọc được ai/hệ thống đã đổi lớp nào, lúc nào và trước/sau ra sao.
-- Khi lỗi: transaction hoàn tác; luồng chấm và dữ liệu hiện tại không bị thay đổi.

ALTER TABLE writing_flow.operator_event
  DROP CONSTRAINT IF EXISTS operator_event_event_type_check;
ALTER TABLE writing_flow.operator_event
  ADD CONSTRAINT operator_event_event_type_check CHECK (event_type IN (
    'retry_requested','rerun_requested','skipped','restored','source_edited',
    'manual_source_added','class_scan_requested','legacy_imported','legacy_promoted',
    'class_mapping_changed'
  ));

CREATE INDEX IF NOT EXISTS writing_operator_event_class_idx
  ON writing_flow.operator_event (class_code,created_at DESC,event_id DESC);

COMMIT;
