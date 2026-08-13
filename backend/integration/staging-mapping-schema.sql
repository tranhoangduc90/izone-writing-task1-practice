-- Dữ liệu nhận vào: database staging trống.
-- Việc chính: tạo đúng bốn bảng mapping tối thiểu mà API và hàm đồng bộ roster sử dụng.
-- Kết quả: migration được kiểm thử mà không sao chép dữ liệu hay view phụ thuộc từ production.
-- Khi lỗi: psql dừng ngay; database staging có thể được tạo lại mà không ảnh hưởng production.
CREATE SCHEMA mapping;

CREATE TABLE mapping.classroom_course_mapping (
  id BIGSERIAL PRIMARY KEY,
  erp_course_class_id BIGINT NOT NULL UNIQUE,
  erp_class_name_snapshot TEXT NOT NULL,
  classroom_course_id TEXT UNIQUE,
  classroom_course_name_snapshot TEXT,
  status TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE mapping.classroom_roster_snapshot (
  id BIGSERIAL PRIMARY KEY,
  classroom_course_id TEXT NOT NULL,
  classroom_user_id TEXT NOT NULL,
  classroom_name_snapshot TEXT,
  roster_state TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (classroom_course_id, classroom_user_id)
);

CREATE TABLE mapping.student_mapping_review (
  id BIGSERIAL PRIMARY KEY,
  erp_course_class_id BIGINT NOT NULL,
  erp_student_contact_id BIGINT NOT NULL,
  erp_student_name_snapshot TEXT NOT NULL,
  classroom_course_id TEXT,
  classroom_user_id TEXT,
  classroom_name_snapshot TEXT,
  match_method TEXT NOT NULL,
  status TEXT NOT NULL,
  public_id UUID NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (erp_course_class_id, classroom_user_id)
);

CREATE TABLE mapping.reviewer_account (
  email TEXT PRIMARY KEY,
  google_subject TEXT,
  display_name TEXT,
  role TEXT NOT NULL,
  status TEXT NOT NULL,
  can_access_all_classes BOOLEAN NOT NULL DEFAULT false,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
