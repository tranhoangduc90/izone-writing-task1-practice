
      CREATE SCHEMA mapping;
      CREATE SCHEMA writing_flow;
      CREATE TABLE mapping.classroom_course_mapping
        (erp_course_class_id bigint,erp_class_name_snapshot text);
      CREATE TABLE mapping.reviewer_class_access
        (erp_course_class_id bigint,reviewer_email text);
      CREATE TABLE mapping.reviewer_account
        (email text,status text,display_name text);
      CREATE FUNCTION writing_flow.normalize_search(value text) RETURNS text
        LANGUAGE sql IMMUTABLE AS $$ SELECT lower(coalesce(value,'')) $$;
      CREATE TABLE writing_flow.pair (
        pair_id uuid PRIMARY KEY,class_code text,source_app_id text,source_table_id text,
        source_record_id text,homework_file_id text,source_link_index integer,essay_slot integer,
        task_type text,submission_revision text,status text,source_type text,
        created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
        finished_at timestamptz,skipped_at timestamptz,skipped_by text,skip_reason text,
        trcc_required_override boolean,source_id uuid,source_ciphertext bytea);
      CREATE TABLE writing_flow.source_record (
        source_id uuid PRIMARY KEY,source_type text,source_app_id text,source_table_id text,source_record_id text,
        homework_file_id text,source_link_index integer,class_code text,
        display_name text,student_name text,teacher_names text[],
        classroom_url text,file_url text,source_status text,source_created_at timestamptz);
      CREATE TABLE writing_flow.class_registry
        (class_code text PRIMARY KEY,class_status text,eligibility_reason text);
      CREATE TABLE writing_flow.stage_result (
        pair_id uuid,stage_key text,status text,attempt_count integer,error_code text,
        result_ciphertext bytea,completed_at timestamptz,cycle_no integer);
      CREATE TABLE writing_flow.source_issue (
        source_app_id text,source_table_id text,source_record_id text,
        homework_file_id text,source_link_index integer,class_code text,status text,
        warning_confirmed_at timestamptz);
      CREATE TABLE writing_flow.manual_review
        (review_id uuid,pair_id uuid,stage_key text,cycle_no integer,status text,
         error_code text,opened_at timestamptz DEFAULT now(),checked_at timestamptz,
         retry_requested_at timestamptz);
      CREATE TABLE writing_flow.workflow_failure (last_seen_at timestamptz);
      CREATE TABLE writing_flow.trcc_repair (pair_id uuid,status text);
      CREATE TABLE writing_flow.test_group
        (test_group_id uuid PRIMARY KEY,test_config text,topology text);
      CREATE TABLE writing_flow.test_pair (
        pair_id uuid PRIMARY KEY,test_group_id uuid,task_number integer,
        historical_evidence jsonb,component_count integer,task_score numeric,status text);
      CREATE TABLE writing_flow.test_final
        (test_group_id uuid,writing_score numeric,status text);
      INSERT INTO writing_flow.class_registry VALUES ('IC2200','on_going','active');
      INSERT INTO writing_flow.pair (pair_id,class_code,source_app_id,source_table_id,
        source_record_id,homework_file_id,source_link_index,essay_slot,task_type,
        submission_revision,status,source_type) VALUES
        ('11111111-1111-4111-8111-111111111111','IC2200','google_classroom','course-a','assignment-a',
          'doc-fake',1,1,'task_2','revision-one','delivered','term_test'),
        ('22222222-2222-4222-8222-222222222222','IC2200','manual','manual','manual-a',
          'doc-fake',1,1,'task_2','revision-one','needs_review','term_test'),
        ('33333333-3333-4333-8333-333333333333','IC2200','google_classroom','course-a','assignment-a',
          'doc-fake',1,1,'task_2','revision-two','received','term_test'),
        ('44444444-4444-4444-8444-444444444444','IC2200','lark','table-a','record-a',
          'doc-fake',1,1,'task_2','revision-one','received','lark_homework');
      INSERT INTO writing_flow.stage_result
        (pair_id,stage_key,status,attempt_count,error_code,cycle_no)
        VALUES ('22222222-2222-4222-8222-222222222222','precheck','needs_review',0,
          'TEST_HISTORICAL_EVIDENCE_CONFLICT',1);
      INSERT INTO writing_flow.manual_review
        (review_id,pair_id,stage_key,cycle_no,status,error_code)
        VALUES ('55555555-5555-4555-8555-555555555555','22222222-2222-4222-8222-222222222222',
          'precheck',1,'open',
          'TEST_HISTORICAL_EVIDENCE_CONFLICT');

  INSERT INTO writing_flow.pair(pair_id,class_code,source_app_id,source_table_id,
    source_record_id,homework_file_id,source_link_index,essay_slot,task_type,submission_revision,status,source_type)
    SELECT md5('pairs-fixture-'||n)::uuid,'IC2200','lark','table-fake','record-'||n,
      'doc-'||n,1,1,'task_1','v1','received','lark_homework' FROM generate_series(1,200)n;
  INSERT INTO writing_flow.stage_result(pair_id,stage_key,status,attempt_count,error_code,cycle_no)
    SELECT md5('pairs-fixture-'||n)::uuid,'main','pending',2,NULL,1 FROM generate_series(1,200)n;
  INSERT INTO writing_flow.stage_result(pair_id,stage_key,status,attempt_count,error_code,cycle_no)
    SELECT md5('pairs-fixture-'||n)::uuid,'critic','running',1,NULL,1 FROM generate_series(1,200)n;
  INSERT INTO writing_flow.stage_result(pair_id,stage_key,status,attempt_count,error_code,cycle_no)
    SELECT md5('pairs-fixture-'||n)::uuid,'precheck','needs_review',1,'FIXTURE_REVIEW',1
    FROM generate_series(1,200)n WHERE n%3=0;
  INSERT INTO writing_flow.trcc_repair VALUES(md5('pairs-fixture-1')::uuid,'pending');
  CREATE UNIQUE INDEX pair_stage_fixture ON writing_flow.stage_result(pair_id,stage_key);

  -- Peer khác app, cùng identity nguồn, NULL identity và superseded; không trộn revision/task/ô bài.
  UPDATE writing_flow.pair SET created_at='2026-10-01T00:00:01Z'
    WHERE pair_id='11111111-1111-4111-8111-111111111111';
  UPDATE writing_flow.pair SET created_at='2026-10-01T00:00:02Z'
    WHERE pair_id='22222222-2222-4222-8222-222222222222';
  INSERT INTO writing_flow.pair(pair_id,class_code,source_app_id,source_table_id,source_record_id,
    homework_file_id,source_link_index,essay_slot,task_type,submission_revision,status,source_type,created_at)
  VALUES
    ('55555555-5555-4555-8555-555555555555','IC2200','different-app','course-a','assignment-a',
      'doc-fake',1,1,'task_2','revision-one','received','term_test','2026-10-01T00:00:03Z'),
    ('66666666-6666-4666-8666-666666666666','IC2200','google_classroom','course-a','assignment-a',
      'doc-fake',1,1,'task_2','revision-one','received','term_test','2026-10-01T00:00:04Z'),
    ('77777777-7777-4777-8777-777777777777','IC2200','google_classroom',NULL,'assignment-a',
      'doc-fake',1,1,'task_2','revision-one','received','term_test','2026-10-01T00:00:05Z'),
    ('88888888-8888-4888-8888-888888888888','IC2200','different-app',NULL,'assignment-a',
      'doc-fake',1,1,'task_2','revision-one','received','term_test','2026-10-01T00:00:06Z'),
    ('99999999-9999-4999-8999-999999999999','IC2200','other-app','other-table','other-record',
      'doc-fake',1,1,'task_2','revision-one','superseded','term_test','2026-10-01T00:00:07Z');
