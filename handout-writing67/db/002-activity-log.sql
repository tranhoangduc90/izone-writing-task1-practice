-- Nhật ký riêng Handout67: nhận sự kiện, input ghim và từng phản hồi AI đã nhận.
-- Không chứa credential/capability; giữ hai tháng lịch từ terminal, không xóa bài làm.
CREATE TABLE IF NOT EXISTS handout67.activity_event (
  event_key text PRIMARY KEY,
  session_ref uuid NOT NULL REFERENCES handout67.session(ref),
  class_ref text NOT NULL,
  student_ref text NOT NULL,
  job_ref uuid,
  attempt_index integer,
  section text,
  idea_index integer,
  kind text NOT NULL,
  event_at timestamptz NOT NULL,
  expires_at timestamptz,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS activity_event_session ON handout67.activity_event(session_ref,event_at,event_key);
CREATE INDEX IF NOT EXISTS activity_event_class ON handout67.activity_event(class_ref,event_at);
CREATE INDEX IF NOT EXISTS activity_event_expiry ON handout67.activity_event(expires_at);
CREATE TABLE IF NOT EXISTS handout67.grading_input (
  job_ref uuid PRIMARY KEY,
  session_ref uuid NOT NULL REFERENCES handout67.session(ref),
  class_ref text NOT NULL,
  student_ref text NOT NULL,
  section text,
  idea_index integer,
  kind text NOT NULL,
  snapshot_hash text NOT NULL,
  snapshot jsonb NOT NULL,
  prompt text,
  prompt_version text NOT NULL,
  operation_key text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz
);
CREATE INDEX IF NOT EXISTS grading_input_session ON handout67.grading_input(session_ref,created_at);
CREATE INDEX IF NOT EXISTS grading_input_expiry ON handout67.grading_input(expires_at);
CREATE TABLE IF NOT EXISTS handout67.grading_attempt (
  job_ref uuid NOT NULL REFERENCES handout67.grading_input(job_ref),
  attempt_index integer NOT NULL CHECK(attempt_index>0),
  attempt_ref uuid NOT NULL UNIQUE,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  expires_at timestamptz,
  status text NOT NULL,
  response_text text,
  response_body jsonb,
  response_hash text,
  model text,
  http_status integer,
  error_code text,
  execution_ref text,
  provider_ref text,
  PRIMARY KEY(job_ref,attempt_index)
);
CREATE INDEX IF NOT EXISTS grading_attempt_expiry ON handout67.grading_attempt(expires_at);

-- Chỉ runtime riêng và role quản trị có quyền tương ứng sau migration/readback.
-- Runtime không tự cấp quyền hoặc tự chạy migration; retention xóa qua hàm hạn chế này.
CREATE OR REPLACE FUNCTION handout67.cleanup_activity_log(p_now timestamptz, p_limit integer DEFAULT 100)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,handout67 AS $$
DECLARE v_jobs uuid[]; v_count integer; v_events integer;
BEGIN
  -- Người gọi không được đẩy đồng hồ vào tương lai để xóa nhật ký chưa đủ tuổi.
  IF p_now IS NULL OR p_now > clock_timestamp() OR p_limit<1 OR p_limit>1000 THEN
    RAISE EXCEPTION 'RETENTION_ARGUMENT_INVALID';
  END IF;
  IF NOT pg_try_advisory_xact_lock(676702) THEN RETURN 0; END IF;
  SELECT array_agg(job_ref) INTO v_jobs FROM (
    SELECT i.job_ref FROM handout67.grading_input i
    JOIN handout67.session s ON s.ref=i.session_ref
    WHERE i.expires_at<=p_now AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(s.payload->'jobs') j
      WHERE j->>'jobRef'=i.job_ref::text AND j->>'status' IN ('queued','leased')
    ) ORDER BY i.expires_at LIMIT p_limit
  ) q;
  DELETE FROM handout67.grading_attempt WHERE job_ref=ANY(v_jobs);
  DELETE FROM handout67.activity_event WHERE job_ref=ANY(v_jobs);
  DELETE FROM handout67.grading_input WHERE job_ref=ANY(v_jobs);
  GET DIAGNOSTICS v_count=ROW_COUNT;
  DELETE FROM handout67.activity_event WHERE event_key IN (
    SELECT event_key FROM handout67.activity_event
    WHERE job_ref IS NULL AND expires_at<=p_now ORDER BY expires_at LIMIT p_limit
  );
  GET DIAGNOSTICS v_events=ROW_COUNT;
  -- Báo có tiến triển cả khi chỉ dọn sự kiện lưu/góp ý; vòng nền tiếp tục lô sau.
  RETURN v_count+v_events;
END $$;
REVOKE ALL ON FUNCTION handout67.cleanup_activity_log(timestamptz,integer) FROM PUBLIC;
