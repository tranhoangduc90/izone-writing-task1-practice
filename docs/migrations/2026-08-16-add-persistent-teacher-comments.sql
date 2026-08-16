-- Dữ liệu nhận vào: bài làm đã lưu và comment trực tiếp do giảng viên tạo trên một đoạn chữ.
-- Việc chính: lưu thread, từng tin nhắn và lịch sử đổi trạng thái theo kiểu chỉ thêm mới.
-- Kết quả: comment giảng viên tách hoàn toàn khỏi Comment AI/Check và không thể bị xóa qua API.
-- Khi lỗi: toàn bộ migration rollback; luồng Check/AI hiện hành không bị thay đổi.
BEGIN;

CREATE TABLE writing_practice.teacher_comment_thread (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  session_id UUID NOT NULL REFERENCES writing_practice.activity_session(id) ON DELETE RESTRICT,
  section_key TEXT NOT NULL CHECK (section_key ~ '^[a-z0-9][a-z0-9_]{1,79}$'),
  field_key TEXT NOT NULL CHECK (field_key ~ '^[a-z0-9][a-z0-9_]{1,79}$'),
  anchor_start INTEGER NOT NULL CHECK (anchor_start >= 0),
  anchor_end INTEGER NOT NULL CHECK (anchor_end > anchor_start),
  anchor_quote TEXT NOT NULL CHECK (length(anchor_quote) BETWEEN 1 AND 2000),
  anchor_prefix TEXT NOT NULL DEFAULT '' CHECK (length(anchor_prefix) <= 120),
  anchor_suffix TEXT NOT NULL DEFAULT '' CHECK (length(anchor_suffix) <= 120),
  anchor_revision INTEGER NOT NULL CHECK (anchor_revision >= 0),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','addressed')),
  created_by TEXT NOT NULL,
  request_id UUID NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  addressed_at TIMESTAMPTZ
);

CREATE INDEX teacher_comment_thread_session_idx
  ON writing_practice.teacher_comment_thread(session_id, field_key, created_at);

CREATE TABLE writing_practice.teacher_comment_message (
  id BIGSERIAL PRIMARY KEY,
  public_id UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  thread_id UUID NOT NULL REFERENCES writing_practice.teacher_comment_thread(id) ON DELETE RESTRICT,
  author_role TEXT NOT NULL CHECK (author_role IN ('teacher','student')),
  author_ref TEXT NOT NULL,
  body TEXT NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 5000),
  request_id UUID NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX teacher_comment_message_thread_idx
  ON writing_practice.teacher_comment_message(thread_id, created_at, id);

CREATE TABLE writing_practice.teacher_comment_status_event (
  id BIGSERIAL PRIMARY KEY,
  thread_id UUID NOT NULL REFERENCES writing_practice.teacher_comment_thread(id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('open','addressed')),
  actor_ref TEXT NOT NULL,
  request_id UUID NOT NULL UNIQUE,
  request_hash TEXT NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX teacher_comment_status_event_thread_idx
  ON writing_practice.teacher_comment_status_event(thread_id, created_at, id);

-- Comment trực tiếp hết hạn cùng bài làm, nhưng không có endpoint xóa riêng lẻ.
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
  DELETE FROM writing_practice.teacher_comment_status_event event USING writing_practice.teacher_comment_thread thread,expired_writing_sessions expired
    WHERE event.thread_id=thread.id AND thread.session_id=expired.id;
  DELETE FROM writing_practice.teacher_comment_message message USING writing_practice.teacher_comment_thread thread,expired_writing_sessions expired
    WHERE message.thread_id=thread.id AND thread.session_id=expired.id;
  DELETE FROM writing_practice.teacher_comment_thread thread USING expired_writing_sessions expired WHERE thread.session_id=expired.id;
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

REVOKE ALL ON writing_practice.teacher_comment_thread,
  writing_practice.teacher_comment_message,
  writing_practice.teacher_comment_status_event FROM PUBLIC;

DO $permissions$
BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='writing_practice_api') THEN
    GRANT SELECT,INSERT,UPDATE ON writing_practice.teacher_comment_thread,
      writing_practice.teacher_comment_message,
      writing_practice.teacher_comment_status_event TO writing_practice_api;
    GRANT USAGE,SELECT ON SEQUENCE writing_practice.teacher_comment_message_id_seq,
      writing_practice.teacher_comment_status_event_id_seq TO writing_practice_api;
  END IF;
END $permissions$;

COMMIT;
