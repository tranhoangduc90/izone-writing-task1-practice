-- Dữ liệu vào: hai roster giả đã tạo và bảng quyền v16 trong database staging.
-- Việc chính: mở riêng bốn đề Substitute cho hai lớp giả, ghim đúng rubric.
-- Kết quả: chỉ học viên giả được thử API; các lớp/đề khác vẫn đóng mặc định.
-- Khi lỗi: rollback; không bật quyền cho bất kỳ lớp thật nào.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF current_database() <> 'writing_practice_staging' THEN
    RAISE EXCEPTION 'WEB_STAGING_DATABASE_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM assessment_k56.term_test_roster) <> 1
    OR (SELECT count(*) FROM assessment.term_test_roster) <> 1
    OR NOT EXISTS (
      SELECT 1 FROM assessment_k56.term_test_roster
      WHERE erp_course_class_id = 990056001
        AND erp_student_contact_id = 990056101
        AND student_name_snapshot = 'Học viên giả khóa 56'
    )
    OR NOT EXISTS (
      SELECT 1 FROM assessment.term_test_roster
      WHERE erp_course_class_id = 990067001
        AND erp_student_contact_id = 990067101
        AND student_name_snapshot = 'Học viên giả khóa 67'
    ) THEN
    RAISE EXCEPTION 'WEB_STAGING_ROSTER_FIXTURE_MISMATCH';
  END IF;
  IF EXISTS (
    SELECT 1 FROM writing_flow.web_substitute_access
    WHERE erp_course_class_id IN (990056001, 990067001)
  ) THEN
    RAISE EXCEPTION 'WEB_STAGING_ACCESS_ALREADY_EXISTS';
  END IF;
END;
$guard$;

INSERT INTO writing_flow.web_substitute_access
  (test_slug, cohort, erp_course_class_id, rubric_version, enabled, source)
VALUES
  ('substitute-test-1-k56', 56, 990056001,
   'substitute-test1-k56-isolated-20260915-v1', true, 'staging_fixture'),
  ('substitute-test-2-k56', 56, 990056001,
   'substitute-test2-k56-isolated-20260917-v1', true, 'staging_fixture'),
  ('substitute-test-1-k67', 67, 990067001,
   'test56-67-parity-20260908-v1', true, 'staging_fixture'),
  ('substitute-test-2-k67', 67, 990067001,
   'test56-67-parity-20260909-v1', true, 'staging_fixture');

COMMIT;
