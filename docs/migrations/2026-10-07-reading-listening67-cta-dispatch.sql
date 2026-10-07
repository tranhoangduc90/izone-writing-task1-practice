-- Lưu xác nhận gửi CTA sau RabbitMQ nhận; chưa gửi được vẫn được thử lại.
-- Chỉ thay database/schema Reading Listening 67, không đụng bảng sản phẩm khác.
BEGIN;
ALTER TABLE reading_listening67.source_document
  ADD COLUMN IF NOT EXISTS cta_dispatch_token uuid,
  ADD COLUMN IF NOT EXISTS cta_enqueued_at timestamptz;
COMMIT;
