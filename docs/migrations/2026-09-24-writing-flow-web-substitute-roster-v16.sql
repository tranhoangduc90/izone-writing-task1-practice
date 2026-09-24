-- Dữ liệu vào: roster Term của hai cohort đã đồng bộ trong mapping_db chung.
-- Việc chính: đặt cờ mở Substitute riêng, mặc định đóng, và tra đúng một tên trong lớp.
-- Kết quả: API Writing chỉ gọi hàm tra cứu; không có quyền đọc toàn bộ roster.
-- Khi lỗi: transaction rollback; không sửa bài, điểm, roster hoặc workflow đang chạy.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('mapping_db_schema_migrations'));

CREATE TABLE IF NOT EXISTS writing_flow.web_substitute_access (
  test_slug text NOT NULL CHECK (test_slug IN (
    'substitute-test-1-k56', 'substitute-test-2-k56',
    'substitute-test-1-k67', 'substitute-test-2-k67'
  )),
  cohort smallint NOT NULL CHECK (cohort IN (56, 67)),
  erp_course_class_id bigint NOT NULL CHECK (erp_course_class_id > 0),
  enabled boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'manual_review',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (test_slug, erp_course_class_id),
  CONSTRAINT web_substitute_access_slug_cohort_check CHECK (
    (cohort = 56 AND right(test_slug, 3) = 'k56') OR
    (cohort = 67 AND right(test_slug, 3) = 'k67')
  )
);

-- Không đưa tên hoặc toàn bộ danh sách ra khỏi database. Nếu hai học viên
-- cùng tên trong một lớp, trả mã lỗi để quản trị viên xử lý riêng.
CREATE OR REPLACE FUNCTION writing_flow.resolve_web_substitute_student(
  p_test_slug text,
  p_class_id bigint,
  p_student_name text
) RETURNS TABLE (
  cohort smallint,
  erp_course_class_id bigint,
  erp_student_contact_id bigint
) LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path = pg_catalog, writing_flow, assessment, assessment_k56
AS $function$
DECLARE
  v_cohort smallint;
  v_count integer;
BEGIN
  IF p_class_id IS NULL OR p_class_id <= 0
    OR p_student_name IS NULL OR length(btrim(p_student_name)) < 2 THEN
    RAISE EXCEPTION 'WEB_ROSTER_INPUT_INVALID';
  END IF;

  SELECT access.cohort INTO v_cohort
  FROM writing_flow.web_substitute_access AS access
  WHERE access.test_slug = p_test_slug
    AND access.erp_course_class_id = p_class_id
    AND access.enabled = true;
  IF v_cohort IS NULL THEN
    RAISE EXCEPTION 'WEB_TEST_ACCESS_CLOSED';
  END IF;

  -- Cùng một học viên có thể nằm ở nhiều roster Term/Mini với student_ref
  -- khác nhau; mã học viên ERP mới là khóa chung ổn định cho bài web.
  -- K56 còn phải giữ cờ đủ điều kiện của lượt đồng bộ ERP mới nhất.
  IF v_cohort = 56 THEN
    SELECT count(*), min(candidate.erp_student_contact_id)
      INTO v_count, erp_student_contact_id
    FROM (
      SELECT DISTINCT roster.erp_student_contact_id
      FROM assessment_k56.term_test_roster AS roster
      WHERE roster.erp_course_class_id = p_class_id
        AND roster.is_eligible = true
        AND lower(btrim(regexp_replace(roster.student_name_snapshot,
          '[[:space:]]+', ' ', 'g'))) = lower(btrim(regexp_replace(
          p_student_name, '[[:space:]]+', ' ', 'g')))
    ) AS candidate;
  ELSE
    SELECT count(*), min(candidate.erp_student_contact_id)
      INTO v_count, erp_student_contact_id
    FROM (
      SELECT DISTINCT roster.erp_student_contact_id
      FROM assessment.term_test_roster AS roster
      WHERE roster.erp_course_class_id = p_class_id
        AND lower(btrim(regexp_replace(roster.student_name_snapshot,
          '[[:space:]]+', ' ', 'g'))) = lower(btrim(regexp_replace(
          p_student_name, '[[:space:]]+', ' ', 'g')))
    ) AS candidate;
  END IF;

  IF v_count = 0 THEN RAISE EXCEPTION 'WEB_ROSTER_NAME_NOT_FOUND'; END IF;
  IF v_count <> 1 THEN RAISE EXCEPTION 'WEB_ROSTER_NAME_AMBIGUOUS'; END IF;
  cohort := v_cohort;
  erp_course_class_id := p_class_id;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON writing_flow.web_substitute_access FROM PUBLIC;
REVOKE ALL ON FUNCTION writing_flow.resolve_web_substitute_student(text,bigint,text)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION writing_flow.resolve_web_substitute_student(text,bigint,text)
  TO writing_practice_api;

COMMIT;
