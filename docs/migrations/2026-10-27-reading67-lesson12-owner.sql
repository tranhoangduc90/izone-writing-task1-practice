-- View chỉ đọc riêng Lesson 12, danh sách lớp K67 đang học/sắp mở từ ERP ngày 27/10.
-- Giữ nguyên view owner cũ; chỉ hồ sơ, lớp Classroom và thành viên hiện hành đã duyệt.
BEGIN;
CREATE VIEW reading_owner_api_v1.homework_lesson12_owner AS
SELECT m.erp_course_class_id::text AS class_id,m.public_id AS student_ref,
       c.classroom_course_id AS course_id,m.classroom_user_id AS google_user_id
FROM mapping.student_mapping_review m
JOIN mapping.classroom_course_mapping c ON c.erp_course_class_id=m.erp_course_class_id AND c.status='approved'
WHERE m.status='approved' AND m.classroom_user_id IS NOT NULL AND m.classroom_course_id=c.classroom_course_id
AND m.erp_course_class_id IN(1187,1193,1199,1216,1226,1250,1258,1261,1293,1307,1333,1345,1356,1370)
AND EXISTS(SELECT 1 FROM mapping.erp_class_membership_snapshot e
 WHERE e.erp_course_class_id=m.erp_course_class_id AND e.erp_student_contact_id=m.erp_student_contact_id
 AND e.source_state='active' AND lower(trim(coalesce(e.registration_status,''))) NOT IN('dropped','on_hold'));
REVOKE ALL ON reading_owner_api_v1.homework_lesson12_owner FROM PUBLIC;
GRANT SELECT ON reading_owner_api_v1.homework_lesson12_owner TO reading_owner_reader;
COMMIT;
