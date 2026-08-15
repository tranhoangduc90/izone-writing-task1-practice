-- Dữ liệu nhận vào: họ tên, UUID công khai và mã 4 số đã được API băm bằng scrypt.
-- Việc chính: lưu hồ sơ tạm, alias đối soát và audit không chứa mã/hash.
-- Kết quả: học viên vào học ngay; sau khi ghép, UUID/session cũ vẫn là nguồn bài làm duy nhất.
-- Khi lỗi: toàn bộ migration rollback; không thay đổi roster hay bài làm đang chạy.
BEGIN;

CREATE TABLE writing_practice.provisional_student (
  activity_class_id BIGINT NOT NULL REFERENCES writing_practice.activity_class_scope(id) ON DELETE RESTRICT,
  student_public_id UUID NOT NULL DEFAULT gen_random_uuid(),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 100),
  normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) BETWEEN 2 AND 100),
  display_alias TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','matched','conflict')),
  pin_salt TEXT NOT NULL CHECK (length(pin_salt) BETWEEN 20 AND 100),
  pin_hash TEXT NOT NULL CHECK (length(pin_hash) BETWEEN 40 AND 100),
  failed_pin_attempts SMALLINT NOT NULL DEFAULT 0 CHECK (failed_pin_attempts BETWEEN 0 AND 5),
  pin_locked_until TIMESTAMPTZ,
  registration_request_id UUID NOT NULL,
  matched_student_public_id UUID,
  reconciled_at TIMESTAMPTZ,
  reconciled_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_class_id, student_public_id),
  UNIQUE (student_public_id),
  UNIQUE (activity_class_id, registration_request_id),
  CHECK ((status='matched')=(matched_student_public_id IS NOT NULL))
);
CREATE INDEX provisional_student_pending_idx ON writing_practice.provisional_student(activity_class_id,normalized_name) WHERE status='pending';

CREATE TABLE writing_practice.activity_student_alias (
  activity_class_id BIGINT NOT NULL REFERENCES writing_practice.activity_class_scope(id) ON DELETE RESTRICT,
  alias_student_public_id UUID NOT NULL,
  canonical_student_public_id UUID NOT NULL,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_class_id,alias_student_public_id),
  CHECK (alias_student_public_id<>canonical_student_public_id)
);

CREATE TABLE writing_practice.provisional_student_audit (
  id BIGSERIAL PRIMARY KEY,
  activity_class_id BIGINT NOT NULL REFERENCES writing_practice.activity_class_scope(id) ON DELETE RESTRICT,
  student_public_id UUID NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created','code_reset','matched','conflict_detected')),
  actor_ref TEXT NOT NULL,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX provisional_student_audit_student_idx ON writing_practice.provisional_student_audit(activity_class_id,student_public_id,created_at);

-- Lần làm mới roster không được làm biến mất học viên tạm chưa đối soát.
CREATE OR REPLACE FUNCTION writing_practice.refresh_activity_roster(p_activity_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE writing_practice.activity_roster roster SET active=false,updated_at=now()
  FROM writing_practice.activity_class_scope scope
  WHERE roster.activity_class_id=scope.id AND scope.activity_id=p_activity_id;

  INSERT INTO writing_practice.activity_roster(activity_class_id,student_public_id,display_name,display_alias,active)
  WITH approved AS (
    SELECT scope.id activity_class_id,review.erp_student_contact_id,review.public_id student_public_id,
      COALESCE(NULLIF(trim(review.classroom_name_snapshot),''),'Học viên') display_name
    FROM writing_practice.activity_class_scope scope
    JOIN mapping.classroom_course_mapping course ON course.erp_course_class_id=scope.erp_course_class_id AND course.status='approved'
    JOIN mapping.classroom_roster_snapshot classroom ON classroom.classroom_course_id=course.classroom_course_id AND classroom.roster_state='active'
    JOIN mapping.student_mapping_review review ON review.erp_course_class_id=course.erp_course_class_id
      AND review.classroom_user_id=classroom.classroom_user_id AND review.status='approved'
    WHERE scope.activity_id=p_activity_id
  ), manual_override AS (
    SELECT override.activity_class_id,override.erp_student_contact_id,override.student_public_id,trim(override.display_name) display_name
    FROM writing_practice.activity_roster_override override
    JOIN writing_practice.activity_class_scope scope ON scope.id=override.activity_class_id
    WHERE scope.activity_id=p_activity_id AND override.active
  ), eligible AS (
    SELECT activity_class_id,student_public_id,display_name FROM approved
    UNION ALL
    SELECT manual.activity_class_id,manual.student_public_id,manual.display_name FROM manual_override manual
    WHERE NOT EXISTS (SELECT 1 FROM approved WHERE approved.activity_class_id=manual.activity_class_id
      AND approved.erp_student_contact_id=manual.erp_student_contact_id)
  ), pending AS (
    SELECT provisional.activity_class_id,provisional.student_public_id,provisional.display_name
    FROM writing_practice.provisional_student provisional
    JOIN writing_practice.activity_class_scope scope ON scope.id=provisional.activity_class_id
    WHERE scope.activity_id=p_activity_id AND provisional.status='pending'
  ), all_students AS (
    SELECT * FROM eligible UNION ALL SELECT * FROM pending
  )
  SELECT activity_class_id,student_public_id,display_name,
    CASE WHEN count(*) OVER(PARTITION BY activity_class_id,lower(display_name))>1
      THEN display_name||' · '||upper(left(replace(student_public_id::text,'-',''),4)) ELSE display_name END,true
  FROM all_students
  ON CONFLICT(activity_class_id,student_public_id) DO UPDATE SET display_name=EXCLUDED.display_name,
    display_alias=EXCLUDED.display_alias,active=true,updated_at=now();
END $$;

-- Mở rộng tác vụ xóa hiện tại để hồ sơ tạm và audit cũng hết hạn cùng bài làm.
CREATE OR REPLACE FUNCTION writing_practice.purge_expired_student_data()
RETURNS TABLE(deleted_sessions BIGINT) LANGUAGE plpgsql AS $$
DECLARE v_count BIGINT;
BEGIN
  DROP TABLE IF EXISTS pg_temp.expired_writing_sessions;
  DROP TABLE IF EXISTS pg_temp.expired_writing_scopes;
  CREATE TEMP TABLE expired_writing_scopes ON COMMIT DROP AS
    SELECT scope.id FROM writing_practice.activity_class_scope scope WHERE scope.end_date+180<CURRENT_DATE FOR UPDATE;
  CREATE TEMP TABLE expired_writing_sessions ON COMMIT DROP AS
    SELECT session.id FROM writing_practice.activity_session session
    JOIN expired_writing_scopes scope ON scope.id=session.activity_class_id FOR UPDATE;
  DELETE FROM writing_practice.admin_audit_event audit USING expired_writing_sessions expired WHERE audit.session_id=expired.id;
  DELETE FROM writing_practice.comment comment USING expired_writing_sessions expired WHERE comment.session_id=expired.id;
  DELETE FROM writing_practice.check_attempt attempt USING expired_writing_sessions expired WHERE attempt.session_id=expired.id;
  DELETE FROM writing_practice.draft_request request USING expired_writing_sessions expired WHERE request.session_id=expired.id;
  DELETE FROM writing_practice.session_section section USING expired_writing_sessions expired WHERE section.session_id=expired.id;
  DELETE FROM writing_practice.activity_session session USING expired_writing_sessions expired WHERE session.id=expired.id;
  GET DIAGNOSTICS v_count=ROW_COUNT;
  DELETE FROM writing_practice.provisional_student_audit audit USING expired_writing_scopes scope WHERE audit.activity_class_id=scope.id;
  DELETE FROM writing_practice.activity_student_alias alias USING expired_writing_scopes scope WHERE alias.activity_class_id=scope.id;
  DELETE FROM writing_practice.activity_roster roster USING expired_writing_scopes scope
    WHERE roster.activity_class_id=scope.id AND EXISTS(SELECT 1 FROM writing_practice.provisional_student provisional
      WHERE provisional.activity_class_id=roster.activity_class_id AND provisional.student_public_id=roster.student_public_id);
  DELETE FROM writing_practice.provisional_student provisional USING expired_writing_scopes scope WHERE provisional.activity_class_id=scope.id;
  RETURN QUERY SELECT v_count;
END $$;

REVOKE ALL ON writing_practice.provisional_student,writing_practice.activity_student_alias,writing_practice.provisional_student_audit FROM PUBLIC;
DO $permissions$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='writing_practice_api') THEN
    GRANT SELECT,INSERT,UPDATE ON writing_practice.provisional_student,writing_practice.activity_student_alias,writing_practice.provisional_student_audit TO writing_practice_api;
    GRANT USAGE,SELECT ON SEQUENCE writing_practice.provisional_student_audit_id_seq TO writing_practice_api;
  END IF;
END $permissions$;

COMMIT;
