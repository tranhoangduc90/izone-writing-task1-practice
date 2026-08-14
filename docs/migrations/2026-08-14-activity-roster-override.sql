-- Dữ liệu nhận vào: một học viên ERP cần vào handout nhưng chưa có tài khoản trong Classroom roster.
-- Việc chính: lưu ngoại lệ có phê duyệt bằng ID nội bộ, tạo UUID công khai và gộp ngoại lệ vào lần làm mới roster.
-- Kết quả: API chỉ trả UUID và tên hiển thị; ERP ID, người phê duyệt và lý do luôn ở PostgreSQL nội bộ.
-- Khi lỗi: transaction rollback toàn bộ; roster đang hoạt động không bị thay đổi.
BEGIN;

CREATE TABLE IF NOT EXISTS writing_practice.activity_roster_override (
  activity_class_id BIGINT NOT NULL REFERENCES writing_practice.activity_class_scope(id) ON DELETE RESTRICT,
  erp_student_contact_id BIGINT NOT NULL,
  student_public_id UUID NOT NULL DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL CHECK (trim(display_name) <> ''),
  active BOOLEAN NOT NULL DEFAULT true,
  approved_by TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_class_id, erp_student_contact_id),
  UNIQUE (activity_class_id, student_public_id)
);

REVOKE ALL ON writing_practice.activity_roster_override FROM PUBLIC;

CREATE OR REPLACE FUNCTION writing_practice.refresh_activity_roster(p_activity_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE writing_practice.activity_roster roster SET active = false, updated_at = now()
  FROM writing_practice.activity_class_scope scope
  WHERE roster.activity_class_id = scope.id AND scope.activity_id = p_activity_id;

  INSERT INTO writing_practice.activity_roster(activity_class_id, student_public_id, display_name, display_alias, active)
  WITH approved AS (
    SELECT scope.id AS activity_class_id,
      review.erp_student_contact_id,
      review.public_id AS student_public_id,
      COALESCE(NULLIF(trim(review.classroom_name_snapshot), ''), 'Học viên') AS display_name
    FROM writing_practice.activity_class_scope scope
    JOIN mapping.classroom_course_mapping course
      ON course.erp_course_class_id = scope.erp_course_class_id AND course.status = 'approved'
    JOIN mapping.classroom_roster_snapshot classroom
      ON classroom.classroom_course_id = course.classroom_course_id AND classroom.roster_state = 'active'
    JOIN mapping.student_mapping_review review
      ON review.erp_course_class_id = course.erp_course_class_id
      AND review.classroom_user_id = classroom.classroom_user_id
      AND review.status = 'approved'
    WHERE scope.activity_id = p_activity_id
  ), manual_override AS (
    SELECT override.activity_class_id,
      override.erp_student_contact_id,
      override.student_public_id,
      trim(override.display_name) AS display_name
    FROM writing_practice.activity_roster_override override
    JOIN writing_practice.activity_class_scope scope ON scope.id = override.activity_class_id
    WHERE scope.activity_id = p_activity_id AND override.active
  ), eligible AS (
    SELECT activity_class_id, erp_student_contact_id, student_public_id, display_name FROM approved
    UNION ALL
    SELECT manual.activity_class_id, manual.erp_student_contact_id, manual.student_public_id, manual.display_name
    FROM manual_override manual
    WHERE NOT EXISTS (
      SELECT 1 FROM approved
      WHERE approved.activity_class_id = manual.activity_class_id
        AND approved.erp_student_contact_id = manual.erp_student_contact_id
    )
  )
  SELECT activity_class_id, student_public_id, display_name,
    CASE WHEN count(*) OVER (PARTITION BY activity_class_id, lower(display_name)) > 1
      THEN display_name || ' · ' || upper(left(replace(student_public_id::text, '-', ''), 4))
      ELSE display_name END,
    true
  FROM eligible
  ON CONFLICT(activity_class_id, student_public_id) DO UPDATE
    SET display_name = EXCLUDED.display_name,
      display_alias = EXCLUDED.display_alias,
      active = true,
      updated_at = now();
END $$;

REVOKE ALL ON FUNCTION writing_practice.refresh_activity_roster(BIGINT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION writing_practice.refresh_activity_roster(BIGINT) TO writing_practice_api;

COMMIT;
