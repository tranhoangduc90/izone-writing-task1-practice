-- Mục đích: lưu luyện Writing Task 1 theo hợp đồng v1, tách hoàn toàn dữ liệu riêng tư.
-- Dữ liệu nhận vào: UUID công khai mapping, bản nháp và snapshot Check; không lưu email/ERP ID vào API response.
-- Kết quả: có hàng đợi lease, Comment bất biến và xóa dữ liệu sau end_date + 180 ngày.
-- Lỗi: chạy trong transaction; bất cứ lỗi nào sẽ rollback toàn bộ migration.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE SCHEMA IF NOT EXISTS writing_practice;

CREATE TABLE writing_practice.activity (
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  slug TEXT NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,79}$'),
  content_version TEXT NOT NULL CHECK (length(trim(content_version)) BETWEEN 1 AND 100),
  manifest_checksum TEXT NOT NULL CHECK (manifest_checksum ~ '^[0-9a-f]{64}$'),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  task_prompt TEXT NOT NULL,
  prompt_registry_key TEXT NOT NULL DEFAULT 'ielts:wt1:active_prompt_registry:v1'
    CHECK (length(trim(prompt_registry_key)) BETWEEN 1 AND 200),
  prompt_record_ref TEXT NOT NULL,
  prompt_version TEXT NOT NULL CHECK (length(trim(prompt_version)) BETWEEN 1 AND 100),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','retired','closed')),
  end_date DATE NOT NULL,
  purge_after DATE GENERATED ALWAYS AS (end_date + 180) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(slug, content_version)
);
CREATE UNIQUE INDEX activity_one_active_version_idx ON writing_practice.activity(slug) WHERE status = 'active';
CREATE TABLE writing_practice.activity_class_scope (
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  activity_id BIGINT NOT NULL REFERENCES writing_practice.activity(id) ON DELETE RESTRICT,
  erp_course_class_id BIGINT NOT NULL,
  class_name_snapshot TEXT NOT NULL,
  end_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','closed')),
  UNIQUE(activity_id, erp_course_class_id)
);
CREATE TABLE writing_practice.activity_roster (
  activity_class_id BIGINT NOT NULL REFERENCES writing_practice.activity_class_scope(id) ON DELETE RESTRICT,
  student_public_id UUID NOT NULL,
  display_name TEXT NOT NULL,
  display_alias TEXT NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(activity_class_id, student_public_id)
);
CREATE INDEX activity_roster_active_idx ON writing_practice.activity_roster(activity_class_id) WHERE active;
CREATE UNIQUE INDEX activity_roster_active_alias_idx ON writing_practice.activity_roster(activity_class_id, display_alias) WHERE active;

-- n8n gọi hàm này sau khi mapping đồng bộ: chỉ lấy mapping approved và Classroom member còn active.
-- Alias dùng hậu tố UUID công khai cố định, nên không bị đổi giữa các lần GET hay lần đồng bộ.
CREATE OR REPLACE FUNCTION writing_practice.refresh_activity_roster(p_activity_id BIGINT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  UPDATE writing_practice.activity_roster roster SET active = false, updated_at = now()
  FROM writing_practice.activity_class_scope scope
  WHERE roster.activity_class_id = scope.id AND scope.activity_id = p_activity_id;
  INSERT INTO writing_practice.activity_roster(activity_class_id, student_public_id, display_name, display_alias, active)
  WITH approved AS (
    SELECT scope.id AS activity_class_id, review.public_id AS student_public_id,
      COALESCE(NULLIF(trim(review.classroom_name_snapshot), ''), 'Học viên') AS display_name
    FROM writing_practice.activity_class_scope scope
    JOIN mapping.classroom_course_mapping course ON course.erp_course_class_id = scope.erp_course_class_id AND course.status = 'approved'
    JOIN mapping.classroom_roster_snapshot classroom ON classroom.classroom_course_id = course.classroom_course_id AND classroom.roster_state = 'active'
    JOIN mapping.student_mapping_review review ON review.erp_course_class_id = course.erp_course_class_id
      AND review.classroom_user_id = classroom.classroom_user_id AND review.status = 'approved'
    WHERE scope.activity_id = p_activity_id
  )
  SELECT activity_class_id, student_public_id, display_name,
    CASE WHEN count(*) OVER (PARTITION BY activity_class_id, lower(display_name)) > 1
      THEN display_name || ' · ' || upper(left(replace(student_public_id::text, '-', ''), 4))
      ELSE display_name END,
    true
  FROM approved
  ON CONFLICT(activity_class_id, student_public_id) DO UPDATE
    SET display_name = EXCLUDED.display_name, display_alias = EXCLUDED.display_alias, active = true, updated_at = now();
END $$;

CREATE TABLE writing_practice.activity_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  activity_id BIGINT NOT NULL REFERENCES writing_practice.activity(id) ON DELETE RESTRICT,
  activity_class_id BIGINT NOT NULL REFERENCES writing_practice.activity_class_scope(id) ON DELETE RESTRICT,
  student_public_id UUID NOT NULL,
  overview TEXT NOT NULL DEFAULT '', body1 TEXT NOT NULL DEFAULT '', body2 TEXT NOT NULL DEFAULT '',
  draft_version INTEGER NOT NULL DEFAULT 0 CHECK (draft_version >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(activity_id, student_public_id)
);
CREATE TABLE writing_practice.session_section (
  session_id UUID NOT NULL REFERENCES writing_practice.activity_session(id) ON DELETE RESTRICT,
  section_key TEXT NOT NULL CHECK(section_key IN ('overview','outline')),
  locked BOOLEAN NOT NULL DEFAULT false, fail_streak INTEGER NOT NULL DEFAULT 0 CHECK(fail_streak >= 0),
  round_number INTEGER NOT NULL DEFAULT 1 CHECK(round_number > 0), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(session_id, section_key)
);
CREATE TABLE writing_practice.draft_request (
  session_id UUID NOT NULL REFERENCES writing_practice.activity_session(id) ON DELETE RESTRICT,
  request_id UUID NOT NULL, body_hash TEXT NOT NULL CHECK(body_hash ~ '^[0-9a-f]{64}$'),
  draft_version INTEGER NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), PRIMARY KEY(session_id, request_id)
);
CREATE TABLE writing_practice.check_attempt (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(), public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  session_id UUID NOT NULL REFERENCES writing_practice.activity_session(id) ON DELETE RESTRICT,
  section_key TEXT NOT NULL CHECK(section_key IN ('overview','outline')), round_number INTEGER NOT NULL,
  comment_number INTEGER NOT NULL CHECK(comment_number > 0),
  request_id UUID NOT NULL UNIQUE, body_hash TEXT NOT NULL CHECK(body_hash ~ '^[0-9a-f]{64}$'),
  snapshot JSONB NOT NULL, status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','leased','completed','failed')),
  result_status TEXT CHECK(result_status IN ('passed','needs_revision')), feedback TEXT, error_code TEXT,
  retry_count SMALLINT NOT NULL DEFAULT 0 CHECK(retry_count BETWEEN 0 AND 3), worker_id TEXT,
  lease_token UUID, lease_expires_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK((status = 'leased') = (lease_token IS NOT NULL AND lease_expires_at IS NOT NULL)),
  CHECK((status = 'completed') = (completed_at IS NOT NULL))
);
CREATE UNIQUE INDEX check_attempt_comment_number_idx ON writing_practice.check_attempt(session_id, section_key, comment_number);
CREATE UNIQUE INDEX check_attempt_one_active_idx ON writing_practice.check_attempt(session_id, section_key) WHERE status IN ('queued','leased');
CREATE INDEX check_attempt_claim_idx ON writing_practice.check_attempt(created_at) WHERE status IN ('queued','leased');
CREATE TABLE writing_practice.comment (
  id BIGSERIAL PRIMARY KEY, public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  attempt_id UUID NOT NULL UNIQUE REFERENCES writing_practice.check_attempt(id) ON DELETE RESTRICT,
  session_id UUID NOT NULL REFERENCES writing_practice.activity_session(id) ON DELETE RESTRICT,
  section_key TEXT NOT NULL CHECK(section_key IN ('overview','outline')),
  comment_number INTEGER NOT NULL CHECK(comment_number > 0),
  status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','completed','technical_error')),
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX comment_session_section_idx ON writing_practice.comment(session_id, section_key, created_at);
CREATE UNIQUE INDEX comment_number_idx ON writing_practice.comment(session_id, section_key, comment_number);

CREATE TABLE writing_practice.admin_audit_event (
  id BIGSERIAL PRIMARY KEY,
  session_id UUID NOT NULL REFERENCES writing_practice.activity_session(id) ON DELETE RESTRICT,
  section_key TEXT NOT NULL CHECK(section_key IN ('overview','outline')),
  action TEXT NOT NULL CHECK(action IN ('reopen_section')),
  actor_ref TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Xóa dữ liệu chi tiết theo hạn giữ đã chốt. Hàm chỉ xóa session của activity đã quá hạn;
-- activity và class scope được giữ lại để đối soát cấu hình nội dung.
CREATE OR REPLACE FUNCTION writing_practice.purge_expired_student_data()
RETURNS TABLE(deleted_sessions BIGINT) LANGUAGE plpgsql AS $$
DECLARE v_count BIGINT;
BEGIN
  DROP TABLE IF EXISTS pg_temp.expired_writing_sessions;
  CREATE TEMP TABLE expired_writing_sessions ON COMMIT DROP AS
    SELECT session.id FROM writing_practice.activity_session session
    JOIN writing_practice.activity_class_scope scope ON scope.id = session.activity_class_id
    WHERE scope.end_date + 180 < CURRENT_DATE
    FOR UPDATE;
  DELETE FROM writing_practice.admin_audit_event audit USING expired_writing_sessions expired WHERE audit.session_id = expired.id;
  DELETE FROM writing_practice.comment comment USING expired_writing_sessions expired WHERE comment.session_id = expired.id;
  DELETE FROM writing_practice.check_attempt attempt USING expired_writing_sessions expired WHERE attempt.session_id = expired.id;
  DELETE FROM writing_practice.draft_request request USING expired_writing_sessions expired WHERE request.session_id = expired.id;
  DELETE FROM writing_practice.session_section section USING expired_writing_sessions expired WHERE section.session_id = expired.id;
  DELETE FROM writing_practice.activity_session session USING expired_writing_sessions expired WHERE session.id = expired.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN QUERY SELECT v_count;
END $$;

REVOKE ALL ON FUNCTION writing_practice.refresh_activity_roster(BIGINT) FROM PUBLIC;
REVOKE ALL ON FUNCTION writing_practice.purge_expired_student_data() FROM PUBLIC;

-- Tài khoản API chỉ có đọc mapping tối thiểu; roster được n8n materialize bằng activity_roster để alias luôn ổn định.
DO $permissions$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'writing_practice_api') THEN
    GRANT USAGE ON SCHEMA writing_practice TO writing_practice_api;
    GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA writing_practice TO writing_practice_api;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA writing_practice TO writing_practice_api;
    GRANT USAGE ON SCHEMA mapping TO writing_practice_api;
    GRANT SELECT, UPDATE ON mapping.reviewer_account TO writing_practice_api;
    GRANT EXECUTE ON FUNCTION writing_practice.refresh_activity_roster(BIGINT) TO writing_practice_api;
  END IF;
END $permissions$;
COMMIT;
