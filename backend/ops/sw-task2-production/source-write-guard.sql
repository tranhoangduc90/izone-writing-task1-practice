CREATE SCHEMA IF NOT EXISTS sw_task2_migration;
CREATE TABLE IF NOT EXISTS sw_task2_migration.frozen_activity(
 activity_id bigint PRIMARY KEY,
 enabled boolean NOT NULL DEFAULT true,
 writer_role name,
 frozen_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION sw_task2_migration.guard_activity_write()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE rows jsonb[]; item jsonb; aid bigint;
 session_key writing_practice.activity_session.id%TYPE;
 attempt_key writing_practice.check_attempt.id%TYPE;
 thread_key writing_practice.teacher_comment_thread.id%TYPE;
BEGIN
 rows:=CASE TG_OP WHEN 'INSERT' THEN ARRAY[to_jsonb(NEW)] WHEN 'DELETE' THEN ARRAY[to_jsonb(OLD)] ELSE ARRAY[to_jsonb(OLD),to_jsonb(NEW)] END;
 FOREACH item IN ARRAY rows LOOP
  aid:=NULL;
  IF TG_TABLE_NAME='activity' THEN aid:=(item->>'id')::bigint;
  ELSIF item ? 'activity_id' THEN aid:=(item->>'activity_id')::bigint;
  ELSIF item ? 'activity_class_id' THEN SELECT c.activity_id INTO aid FROM writing_practice.activity_class_scope c WHERE c.id=(item->>'activity_class_id')::bigint;
  ELSIF item ? 'session_id' THEN session_key:=item->>'session_id'; SELECT s.activity_id INTO aid FROM writing_practice.activity_session s WHERE s.id=session_key;
  ELSIF item ? 'attempt_id' THEN attempt_key:=item->>'attempt_id'; SELECT s.activity_id INTO aid FROM writing_practice.check_attempt a JOIN writing_practice.activity_session s ON s.id=a.session_id WHERE a.id=attempt_key;
  ELSIF item ? 'thread_id' THEN thread_key:=item->>'thread_id'; SELECT s.activity_id INTO aid FROM writing_practice.teacher_comment_thread t JOIN writing_practice.activity_session s ON s.id=t.session_id WHERE t.id=thread_key;
  END IF;
  IF EXISTS(SELECT 1 FROM sw_task2_migration.frozen_activity f WHERE f.activity_id=aid AND f.enabled AND (f.writer_role IS NULL OR f.writer_role=session_user)) THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='SW_TASK2_BACKEND_MOVED';
  END IF;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
DO $$ DECLARE t record; BEGIN
 FOR t IN SELECT table_name FROM information_schema.columns WHERE table_schema='writing_practice' AND (column_name IN('activity_id','activity_class_id','session_id','attempt_id','thread_id') OR (table_name='activity' AND column_name='id')) GROUP BY table_name LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_catalog.pg_trigger WHERE tgrelid=('writing_practice.'||t.table_name)::regclass AND tgname='sw_task2_moved_write_guard') THEN
   EXECUTE format('CREATE TRIGGER sw_task2_moved_write_guard BEFORE INSERT OR UPDATE OR DELETE ON writing_practice.%I FOR EACH ROW EXECUTE FUNCTION sw_task2_migration.guard_activity_write()',t.table_name);
  END IF;
 END LOOP;
END $$;
