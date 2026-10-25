-- Owner-only schema; adapted from pinned Writing core, no external mapping grants/functions.
BEGIN;
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



ALTER TABLE writing_practice.activity_session
  ADD COLUMN IF NOT EXISTS draft1 TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS draft2 TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS draft2_unlocked BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE writing_practice.session_section
  DROP CONSTRAINT IF EXISTS session_section_section_key_check;
ALTER TABLE writing_practice.session_section
  ADD CONSTRAINT session_section_section_key_check
  CHECK (section_key IN ('overview','outline','draft')) NOT VALID;
ALTER TABLE writing_practice.session_section
  VALIDATE CONSTRAINT session_section_section_key_check;

ALTER TABLE writing_practice.check_attempt
  DROP CONSTRAINT IF EXISTS check_attempt_section_key_check;
ALTER TABLE writing_practice.check_attempt
  ADD CONSTRAINT check_attempt_section_key_check
  CHECK (section_key IN ('overview','outline','draft')) NOT VALID;
ALTER TABLE writing_practice.check_attempt
  VALIDATE CONSTRAINT check_attempt_section_key_check;

ALTER TABLE writing_practice.comment
  DROP CONSTRAINT IF EXISTS comment_section_key_check;
ALTER TABLE writing_practice.comment
  ADD CONSTRAINT comment_section_key_check
  CHECK (section_key IN ('overview','outline','draft')) NOT VALID;
ALTER TABLE writing_practice.comment
  VALIDATE CONSTRAINT comment_section_key_check;

ALTER TABLE writing_practice.admin_audit_event
  DROP CONSTRAINT IF EXISTS admin_audit_event_section_key_check;
ALTER TABLE writing_practice.admin_audit_event
  ADD CONSTRAINT admin_audit_event_section_key_check
  CHECK (section_key IN ('overview','outline','draft')) NOT VALID;
ALTER TABLE writing_practice.admin_audit_event
  VALIDATE CONSTRAINT admin_audit_event_section_key_check;



ALTER TABLE writing_practice.activity
  ADD COLUMN IF NOT EXISTS grading_pool TEXT NOT NULL DEFAULT 'task1';

ALTER TABLE writing_practice.activity
  DROP CONSTRAINT IF EXISTS activity_grading_pool_check;
ALTER TABLE writing_practice.activity
  ADD CONSTRAINT activity_grading_pool_check
  CHECK (grading_pool ~ '^[a-z0-9][a-z0-9_-]{1,49}$') NOT VALID;
ALTER TABLE writing_practice.activity
  VALIDATE CONSTRAINT activity_grading_pool_check;

ALTER TABLE writing_practice.activity_session
  ADD COLUMN IF NOT EXISTS response_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS active_field TEXT;

ALTER TABLE writing_practice.activity_session
  DROP CONSTRAINT IF EXISTS activity_session_active_field_check;
ALTER TABLE writing_practice.activity_session
  ADD CONSTRAINT activity_session_active_field_check
  CHECK (active_field IS NULL OR active_field ~ '^[a-z0-9][a-z0-9_]{1,79}$') NOT VALID;
ALTER TABLE writing_practice.activity_session VALIDATE CONSTRAINT activity_session_active_field_check;

CREATE TABLE IF NOT EXISTS writing_practice.activity_section_definition (
  activity_id BIGINT NOT NULL REFERENCES writing_practice.activity(id) ON DELETE RESTRICT,
  section_key TEXT NOT NULL CHECK (section_key ~ '^[a-z0-9][a-z0-9_]{1,79}$'),
  title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 200),
  sort_order SMALLINT NOT NULL CHECK (sort_order > 0),
  input_fields JSONB NOT NULL CHECK (jsonb_typeof(input_fields) = 'array'),
  context_fields JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(context_fields) = 'array'),
  required_fields JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(required_fields) = 'array'),
  validation_mode TEXT NOT NULL DEFAULT 'all' CHECK (validation_mode IN ('all','any')),
  prompt_record_ref TEXT,
  prompt_version TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (activity_id, section_key),
  UNIQUE (activity_id, sort_order)
);

ALTER TABLE writing_practice.check_attempt
  ADD COLUMN IF NOT EXISTS result_artifacts JSONB NOT NULL DEFAULT '{}'::jsonb;

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


ALTER TABLE writing_practice.check_attempt ADD COLUMN late_callback_token uuid;
CREATE SCHEMA task1_private;
CREATE TABLE task1_private.capacity(id int PRIMARY KEY CHECK(id=1));
INSERT INTO task1_private.capacity VALUES(1);
CREATE TABLE task1_private.result_receipt(job_ref uuid PRIMARY KEY,body_hash text NOT NULL,response jsonb NOT NULL);
CREATE TABLE task1_private.teacher_grant(email text PRIMARY KEY,google_subject text NOT NULL,role text NOT NULL CHECK(role IN ('teacher','admin')),active boolean NOT NULL DEFAULT true,class_refs uuid[] NOT NULL DEFAULT '{}');
CREATE TABLE task1_private.prompt(slug text NOT NULL,section text NOT NULL CHECK(section IN ('overview','outline','draft')),version text NOT NULL,template text NOT NULL,sha256 text NOT NULL CHECK(length(sha256)=64),PRIMARY KEY(slug,section,version));
CREATE TABLE task1_private.attempt_context(attempt_id uuid PRIMARY KEY REFERENCES writing_practice.check_attempt(id),context jsonb NOT NULL);
CREATE FUNCTION task1_private.freeze_context() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record;h jsonb;
BEGIN
 SELECT p.*,a.task_prompt INTO STRICT v FROM writing_practice.activity_session s JOIN writing_practice.activity a ON a.id=s.activity_id JOIN task1_private.prompt p ON p.slug=a.slug AND p.version=a.prompt_version AND p.section=NEW.section_key WHERE s.id=NEW.session_id AND a.grading_pool='task1';
 SELECT coalesce(jsonb_agg(jsonb_build_object('commentNumber',c.comment_number,'content',c.content,'snapshot',prior_attempt.snapshot) ORDER BY c.comment_number),'[]') INTO h FROM writing_practice.comment c JOIN writing_practice.check_attempt prior_attempt ON prior_attempt.id=c.attempt_id WHERE c.session_id=NEW.session_id AND c.section_key=NEW.section_key AND c.status='completed';
 INSERT INTO task1_private.attempt_context VALUES(NEW.id,jsonb_build_object('productId','sw-task1','slug',v.slug,'section',NEW.section_key,'promptVersion',v.version,'promptSha256',v.sha256,'template',v.template,'taskPrompt',v.task_prompt,'snapshot',NEW.snapshot,'history',h));
 RETURN NEW;
END $$;
CREATE TRIGGER freeze_task1_context AFTER INSERT ON writing_practice.check_attempt FOR EACH ROW EXECUTE FUNCTION task1_private.freeze_context();
REVOKE ALL ON SCHEMA writing_practice,task1_private FROM PUBLIC;
COMMIT;
