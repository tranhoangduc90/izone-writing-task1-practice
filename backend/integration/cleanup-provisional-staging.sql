-- Chỉ xóa dữ liệu giả có tiền tố cố định của bài kiểm thử hồ sơ tạm staging.
BEGIN;
CREATE TEMP TABLE test_provisional_students ON COMMIT DROP AS
SELECT activity_class_id,student_public_id FROM writing_practice.provisional_student
WHERE display_name LIKE 'ZZ Kiểm thử tạm %';
CREATE TEMP TABLE test_provisional_sessions ON COMMIT DROP AS
SELECT session.id FROM writing_practice.activity_session session
JOIN test_provisional_students student ON student.activity_class_id=session.activity_class_id
  AND student.student_public_id=session.student_public_id;
DELETE FROM writing_practice.admin_audit_event event USING test_provisional_sessions session WHERE event.session_id=session.id;
DELETE FROM writing_practice.comment comment USING test_provisional_sessions session WHERE comment.session_id=session.id;
DELETE FROM writing_practice.check_attempt attempt USING test_provisional_sessions session WHERE attempt.session_id=session.id;
DELETE FROM writing_practice.draft_request request USING test_provisional_sessions session WHERE request.session_id=session.id;
DELETE FROM writing_practice.session_section section USING test_provisional_sessions session WHERE section.session_id=session.id;
DELETE FROM writing_practice.activity_session activity USING test_provisional_sessions session WHERE activity.id=session.id;
DELETE FROM writing_practice.activity_student_alias alias USING test_provisional_students student
WHERE alias.activity_class_id=student.activity_class_id
  AND (alias.alias_student_public_id=student.student_public_id OR alias.canonical_student_public_id=student.student_public_id);
DELETE FROM writing_practice.provisional_student_audit audit USING test_provisional_students student
WHERE audit.activity_class_id=student.activity_class_id AND audit.student_public_id=student.student_public_id;
DELETE FROM writing_practice.activity_roster roster USING test_provisional_students student
WHERE roster.activity_class_id=student.activity_class_id AND roster.student_public_id=student.student_public_id;
DELETE FROM writing_practice.provisional_student provisional USING test_provisional_students student
WHERE provisional.activity_class_id=student.activity_class_id AND provisional.student_public_id=student.student_public_id;
COMMIT;
