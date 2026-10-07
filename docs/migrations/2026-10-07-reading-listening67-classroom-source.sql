-- Lưu nguồn Classroom ngay từ Google, trước bước nhận diện mã bài hoặc gắn CTA.
-- Danh sách lớp là bản sao tối thiểu từ mapping đã duyệt; không kế thừa lọc Writing.
BEGIN;
CREATE TABLE IF NOT EXISTS reading_listening67.course_registry (
  course_id text PRIMARY KEY,
  class_code text NOT NULL,
  classroom_name text NOT NULL,
  source_ref text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reading_listening67.source_document (
  source_id uuid PRIMARY KEY,
  document_id text NOT NULL CHECK(document_id ~ '^[A-Za-z0-9_-]{20,200}$'),
  course_id text NOT NULL,
  coursework_id text NOT NULL,
  submission_id text NOT NULL,
  student_id text,
  class_code text,
  homework_title text,
  source_event_id text NOT NULL,
  cta_state text NOT NULL DEFAULT 'pending' CHECK(cta_state IN ('pending','ready','review','error')),
  cta_error_code text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(document_id,course_id,coursework_id,submission_id)
);
ALTER TABLE reading_listening67.source_document ADD COLUMN IF NOT EXISTS cta_state text NOT NULL DEFAULT 'pending' CHECK(cta_state IN ('pending','ready','review','error'));
ALTER TABLE reading_listening67.source_document ADD COLUMN IF NOT EXISTS cta_error_code text;
CREATE INDEX IF NOT EXISTS rl67_source_document_id ON reading_listening67.source_document(document_id);
REVOKE ALL ON reading_listening67.course_registry,reading_listening67.source_document FROM PUBLIC;
GRANT SELECT,INSERT,UPDATE ON reading_listening67.course_registry TO reading_listening67_api;
GRANT SELECT,INSERT,UPDATE ON reading_listening67.source_document TO reading_listening67_api;
COMMIT;
