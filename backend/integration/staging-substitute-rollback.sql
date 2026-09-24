-- Dữ liệu vào: chỉ các bảng/roster giả đã thêm cho phép thử Substitute staging.
-- Việc chính: kiểm không có lớp hoặc quyền thật rồi gỡ đúng phần thử theo thứ tự FK.
-- Kết quả: các bảng Writing khác giữ nguyên; có thể dựng lại từ snapshot staging.
-- Khi lỗi: rollback toàn bộ; tuyệt đối không dùng trên production hoặc khi có dữ liệu khác.
BEGIN;
SET LOCAL lock_timeout = '5s';

DO $guard$
BEGIN
  IF current_database() <> 'writing_practice_staging' THEN
    RAISE EXCEPTION 'WEB_STAGING_DATABASE_REQUIRED';
  END IF;
  IF (SELECT count(*) FROM assessment_k56.term_test_roster) <> 1
    OR (SELECT count(*) FROM assessment.term_test_roster) <> 1
    OR EXISTS (
      SELECT 1 FROM assessment_k56.term_test_roster
      WHERE erp_course_class_id <> 990056001
        OR erp_student_contact_id <> 990056101
        OR student_name_snapshot <> 'Học viên giả khóa 56'
    )
    OR EXISTS (
      SELECT 1 FROM assessment.term_test_roster
      WHERE erp_course_class_id <> 990067001
        OR erp_student_contact_id <> 990067101
        OR student_name_snapshot <> 'Học viên giả khóa 67'
    )
    OR (SELECT count(*) FROM writing_flow.web_substitute_access) <> 4
    OR EXISTS (
      SELECT 1 FROM writing_flow.web_substitute_access
      WHERE source <> 'staging_fixture'
        OR erp_course_class_id NOT IN (990056001, 990067001)
    )
    OR EXISTS (
      SELECT 1 FROM writing_flow.web_substitute_attempt
      WHERE erp_course_class_id NOT IN (990056001, 990067001)
        OR erp_student_contact_id NOT IN (990056101, 990067101)
    )
    OR EXISTS (
      SELECT 1 FROM writing_flow.web_substitute_submission
      WHERE status = 'running'
    ) THEN
    RAISE EXCEPTION 'WEB_STAGING_ROLLBACK_SCOPE_MISMATCH';
  END IF;
END;
$guard$;

DROP TABLE writing_flow.web_substitute_portal_outbox;
DROP TABLE writing_flow.web_substitute_submission;
DROP TABLE writing_flow.web_substitute_attempt;
DROP FUNCTION writing_flow.resolve_web_substitute_student(text, bigint, text, boolean);
DROP TABLE writing_flow.web_substitute_access;
DROP TABLE assessment_k56.term_test_roster;
DROP TABLE assessment.term_test_roster;
DROP SCHEMA assessment_k56;
DROP SCHEMA assessment;

COMMIT;
