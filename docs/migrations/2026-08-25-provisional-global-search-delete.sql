-- Dữ liệu nhận vào: UUID công khai của hồ sơ tạm, từ khóa tên và UUID hồ sơ chính thức.
-- Việc chính: mở tìm kiếm hồ sơ chính thức toàn database và cho ẩn an toàn hồ sơ tạm.
-- Kết quả: giảng viên ghép được học viên khác lớp; hồ sơ bị xóa biến mất khỏi roster nhưng lịch sử vẫn còn để đối soát.
-- Khi lỗi: toàn bộ migration rollback; xem lỗi PostgreSQL, không có roster hoặc hồ sơ nào bị đổi một phần.
BEGIN;

ALTER TABLE writing_practice.provisional_student
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by TEXT;

ALTER TABLE writing_practice.provisional_student
  DROP CONSTRAINT IF EXISTS provisional_student_status_check;
ALTER TABLE writing_practice.provisional_student
  ADD CONSTRAINT provisional_student_status_check
  CHECK (status IN ('pending','matched','conflict','deleted'));

ALTER TABLE writing_practice.provisional_student_audit
  DROP CONSTRAINT IF EXISTS provisional_student_audit_action_check;
ALTER TABLE writing_practice.provisional_student_audit
  ADD CONSTRAINT provisional_student_audit_action_check
  CHECK (action IN ('created','code_reset','matched','conflict_detected','deleted'));

CREATE OR REPLACE FUNCTION writing_practice.search_official_students(
  p_query TEXT,
  p_exclude_student_public_id UUID DEFAULT NULL,
  p_limit INTEGER DEFAULT 20
)
RETURNS TABLE(
  student_public_id UUID,
  display_name TEXT,
  class_names TEXT[]
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  WITH candidates AS (
    SELECT DISTINCT ON (review.public_id)
      review.public_id,
      review.erp_student_contact_id,
      trim(review.erp_student_name_snapshot) AS display_name
    FROM mapping.student_mapping_review AS review
    WHERE review.status = 'approved'
      AND review.public_id <> COALESCE(
        p_exclude_student_public_id,
        '00000000-0000-0000-0000-000000000000'::uuid
      )
      AND length(trim(p_query)) BETWEEN 2 AND 100
      AND lower(review.erp_student_name_snapshot) LIKE '%' || lower(trim(p_query)) || '%'
    ORDER BY review.public_id, review.updated_at DESC
  )
  SELECT
    candidate.public_id,
    candidate.display_name,
    ARRAY(
      SELECT DISTINCT course.erp_class_name_snapshot
      FROM mapping.student_mapping_review AS related_review
      JOIN mapping.classroom_course_mapping AS course
        ON course.erp_course_class_id = related_review.erp_course_class_id
        AND course.status = 'approved'
      WHERE related_review.erp_student_contact_id = candidate.erp_student_contact_id
        AND related_review.status = 'approved'
        AND NULLIF(trim(course.erp_class_name_snapshot), '') IS NOT NULL
      ORDER BY course.erp_class_name_snapshot
    ) AS class_names
  FROM candidates AS candidate
  ORDER BY
    CASE WHEN lower(candidate.display_name) = lower(trim(p_query)) THEN 0 ELSE 1 END,
    candidate.display_name,
    candidate.public_id
  LIMIT LEAST(GREATEST(p_limit, 1), 20);
$$;

CREATE OR REPLACE FUNCTION writing_practice.resolve_official_student(
  p_student_public_id UUID
)
RETURNS TABLE(
  erp_student_contact_id BIGINT,
  student_public_id UUID,
  display_name TEXT
)
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
  SELECT
    review.erp_student_contact_id,
    review.public_id,
    trim(review.erp_student_name_snapshot)
  FROM mapping.student_mapping_review AS review
  WHERE review.public_id = p_student_public_id
    AND review.status = 'approved'
  ORDER BY review.updated_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION writing_practice.search_official_students(TEXT, UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION writing_practice.resolve_official_student(UUID) FROM PUBLIC;

DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'writing_practice_api') THEN
    GRANT EXECUTE ON FUNCTION writing_practice.search_official_students(TEXT, UUID, INTEGER)
      TO writing_practice_api;
    GRANT EXECUTE ON FUNCTION writing_practice.resolve_official_student(UUID)
      TO writing_practice_api;
  END IF;
END $permissions$;

COMMIT;
