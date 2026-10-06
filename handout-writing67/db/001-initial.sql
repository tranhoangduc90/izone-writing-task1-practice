-- Nhận kết nối tới database riêng; chỉ tạo bảng của handout, không sửa Mapping/Writing.
-- API giữ bài, lịch sử và job trong cùng transaction; lỗi được rollback và trả trạng thái kỹ thuật.
CREATE SCHEMA IF NOT EXISTS handout67;
CREATE TABLE IF NOT EXISTS handout67.session (
  ref uuid PRIMARY KEY,
  identity_key text UNIQUE NOT NULL,
  payload jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS handout67.queue_lock (
  id integer PRIMARY KEY CHECK (id = 1)
);
INSERT INTO handout67.queue_lock (id) VALUES (1) ON CONFLICT DO NOTHING;
