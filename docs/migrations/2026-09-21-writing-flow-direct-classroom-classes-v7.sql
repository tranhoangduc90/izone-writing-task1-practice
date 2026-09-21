BEGIN;

-- Dữ liệu nhận vào: các lớp có trong view vận hành và Google Classroom nhưng không có lớp ERP,
-- trước mắt gồm bốn lớp Term test.
-- Việc chính: lưu ghép nối trực tiếp bằng tên lớp và Classroom course ID, không tạo ID ERP giả.
-- Kết quả: hệ thống Writing quét và chấm các lớp này giống lớp IC/CS.
-- Khi lỗi: transaction hoàn tác; mapping và lịch quét hiện tại giữ nguyên.

CREATE TABLE IF NOT EXISTS mapping.classroom_direct_class (
  class_code text PRIMARY KEY,
  class_name_snapshot text NOT NULL,
  classroom_course_id text NOT NULL UNIQUE,
  classroom_course_name_snapshot text NOT NULL,
  classroom_section_snapshot text,
  status text NOT NULL DEFAULT 'approved'
    CHECK (status IN ('approved','inactive','conflict')),
  class_status text NOT NULL DEFAULT 'on_going'
    CHECK (class_status IN ('on_going','completed','unknown')),
  source_kind text NOT NULL DEFAULT 'classroom_direct'
    CHECK (source_kind IN ('classroom_direct','term_test')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS classroom_direct_class_operational_idx
  ON mapping.classroom_direct_class (status,class_status,class_code);

GRANT SELECT,INSERT,UPDATE ON TABLE mapping.classroom_direct_class TO n8n_erp_sync;
GRANT SELECT ON TABLE mapping.classroom_direct_class TO writing_practice_api;

COMMIT;
