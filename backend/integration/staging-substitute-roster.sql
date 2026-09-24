-- Dữ liệu vào: database Writing staging còn thiếu hai schema roster của Term.
-- Việc chính: tạo hai roster tối thiểu chỉ có học viên/lớp giả để thử Substitute.
-- Kết quả: hàm tra tên v16 có thể được kiểm trên staging, không chép học viên thật.
-- Khi lỗi: cả transaction rollback; không sửa assessment hoặc roster đang tồn tại.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF current_database() <> 'writing_practice_staging' THEN
    RAISE EXCEPTION 'WEB_STAGING_DATABASE_REQUIRED';
  END IF;
  IF to_regnamespace('writing_flow') IS NULL THEN
    RAISE EXCEPTION 'WEB_STAGING_WRITING_FLOW_REQUIRED';
  END IF;
  IF to_regnamespace('assessment') IS NOT NULL
    OR to_regnamespace('assessment_k56') IS NOT NULL THEN
    RAISE EXCEPTION 'WEB_STAGING_ROSTER_ALREADY_EXISTS';
  END IF;
  IF to_regclass('writing_flow.web_substitute_access') IS NOT NULL THEN
    RAISE EXCEPTION 'WEB_STAGING_SUBSTITUTE_ALREADY_EXISTS';
  END IF;
END;
$guard$;

CREATE SCHEMA assessment;
CREATE SCHEMA assessment_k56;

CREATE TABLE assessment.term_test_roster (
  test_slug text NOT NULL,
  erp_course_class_id bigint NOT NULL,
  erp_student_contact_id bigint NOT NULL,
  student_ref uuid NOT NULL,
  student_name_snapshot text NOT NULL
);

CREATE TABLE assessment_k56.term_test_roster (
  test_slug text NOT NULL,
  erp_course_class_id bigint NOT NULL,
  erp_student_contact_id bigint NOT NULL,
  student_ref uuid NOT NULL,
  student_name_snapshot text NOT NULL,
  is_eligible boolean NOT NULL
);

INSERT INTO assessment.term_test_roster
  (test_slug, erp_course_class_id, erp_student_contact_id,
   student_ref, student_name_snapshot)
VALUES
  ('term-test-1', 990067001, 990067101,
   '67000000-0000-4000-8000-000000000001', 'Học viên giả khóa 67');

INSERT INTO assessment_k56.term_test_roster
  (test_slug, erp_course_class_id, erp_student_contact_id,
   student_ref, student_name_snapshot, is_eligible)
VALUES
  ('term-test-1-k56', 990056001, 990056101,
   '56000000-0000-4000-8000-000000000001', 'Học viên giả khóa 56', true);

COMMIT;
