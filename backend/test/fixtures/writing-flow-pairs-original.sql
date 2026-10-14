
        WITH teacher_assignments AS (
  SELECT class_code,array_agg(DISTINCT teacher_name ORDER BY teacher_name) AS teacher_names
    FROM (
      SELECT CASE
        WHEN upper(course.erp_class_name_snapshot) ~ 'IC[[:space:].]*[0-9]{4,6}'
          THEN 'IC' || regexp_replace(substring(upper(course.erp_class_name_snapshot)
            from 'IC[[:space:].]*[0-9]{4,6}'),'[^0-9]','','g')
        WHEN upper(course.erp_class_name_snapshot) ~ 'CS[[:space:].]*[0-9]{6}'
          THEN 'CS.' || regexp_replace(substring(upper(course.erp_class_name_snapshot)
            from 'CS[[:space:].]*[0-9]{6}'),'[^0-9]','','g')
      END AS class_code,
      nullif(trim(account.display_name),'') AS teacher_name
      FROM mapping.classroom_course_mapping AS course
      JOIN mapping.reviewer_class_access AS access
        ON access.erp_course_class_id=course.erp_course_class_id
      JOIN mapping.reviewer_account AS account
        ON account.email=access.reviewer_email AND account.status='active'
    ) AS normalized
   WHERE class_code IS NOT NULL AND teacher_name IS NOT NULL
   GROUP BY class_code
)
        SELECT p.pair_id, p.class_code, p.source_app_id, p.source_table_id,
               p.source_record_id, p.homework_file_id,
               p.source_link_index, p.essay_slot, p.task_type, p.status,
               p.source_type,p.created_at,p.updated_at,p.trcc_required_override,
               coalesce(p.finished_at,deliver.completed_at) AS finished_at,p.skipped_at,
               p.skipped_by,p.skip_reason,
               coalesce(s.display_name,'') AS display_name,
               coalesce(s.student_name,'') AS student_name,
               coalesce(nullif(s.teacher_names,ARRAY[]::text[]),t.teacher_names,ARRAY[]::text[]) AS teacher_names,
               s.classroom_url,s.file_url,s.source_status,s.source_created_at,
               coalesce(current_stage.stage_key,
                 CASE WHEN p.status='delivered' THEN 'deliver' ELSE 'intake' END) AS stage_key,
               coalesce(current_stage.stage_status,
                 CASE WHEN p.status='delivered' THEN 'succeeded' ELSE 'pending' END) AS stage_status,
               coalesce(current_stage.attempt_count,0) AS attempt_count,
               current_stage.error_code AS last_error_code,p.source_ciphertext,
               render.result_ciphertext AS render_result_ciphertext,
               repair.status AS trcc_repair_status,
               test_group.test_config,test_group.topology,test_pair.task_number,
               test_pair.historical_evidence,
               test_pair.component_count,test_pair.task_score,test_pair.status AS test_task_status,
               test_final.writing_score,test_final.status AS test_final_status,
               history.peer_pair_ids AS historical_peer_pair_ids,
               CASE WHEN current_stage.error_code='TEST_HISTORICAL_EVIDENCE_CONFLICT'
                 OR history.peer_conflict THEN 'TEST_HISTORICAL_EVIDENCE_CONFLICT'
                 WHEN history.peer_pair_ids IS NOT NULL
                   THEN 'TEST_DOCUMENT_PAIR_ALREADY_REGISTERED' END AS historical_review_code,
               EXISTS (SELECT 1 FROM writing_flow.stage_result AS graded
                 WHERE graded.pair_id=p.pair_id AND graded.stage_key IN ('main','render')
                   AND graded.status='succeeded') AS grading_text_available
          FROM writing_flow.pair AS p
          LEFT JOIN teacher_assignments AS t ON t.class_code=p.class_code
          LEFT JOIN writing_flow.source_record AS s ON s.source_id=p.source_id
          LEFT JOIN writing_flow.class_registry AS registry ON registry.class_code=p.class_code
          LEFT JOIN writing_flow.stage_result AS deliver
            ON deliver.pair_id=p.pair_id AND deliver.stage_key='deliver'
          LEFT JOIN writing_flow.stage_result AS render
            ON render.pair_id=p.pair_id AND render.stage_key='render' AND render.status='succeeded'
          LEFT JOIN writing_flow.trcc_repair AS repair ON repair.pair_id=p.pair_id
          LEFT JOIN writing_flow.test_pair AS test_pair ON test_pair.pair_id=p.pair_id
          LEFT JOIN writing_flow.test_group AS test_group
            ON test_group.test_group_id=test_pair.test_group_id
          LEFT JOIN writing_flow.test_final AS test_final
            ON test_final.test_group_id=test_group.test_group_id
          LEFT JOIN LATERAL (
            SELECT array_agg(peer.pair_id ORDER BY peer.created_at) AS peer_pair_ids,
              coalesce(bool_or(peer_precheck.error_code='TEST_HISTORICAL_EVIDENCE_CONFLICT'),false)
                AS peer_conflict
            FROM writing_flow.pair AS peer
            LEFT JOIN writing_flow.stage_result AS peer_precheck
              ON peer_precheck.pair_id=peer.pair_id AND peer_precheck.stage_key='precheck'
            WHERE p.source_type='term_test' AND peer.source_type='term_test'
              AND peer.status<>'superseded'
              AND peer.homework_file_id=p.homework_file_id
              AND peer.essay_slot=p.essay_slot
              AND peer.task_type=p.task_type
              AND peer.submission_revision=p.submission_revision
              AND peer.pair_id<>p.pair_id
              AND NOT (peer.source_app_id=p.source_app_id
                AND peer.source_table_id=p.source_table_id
                AND peer.source_record_id=p.source_record_id
                AND peer.source_link_index=p.source_link_index)
          ) AS history ON p.source_type='term_test'
          LEFT JOIN LATERAL (
            SELECT s.stage_key, s.status AS stage_status, s.attempt_count,s.error_code
             FROM writing_flow.stage_result AS s
             WHERE s.pair_id = p.pair_id
               AND s.status IN ('pending','running','needs_review')
             ORDER BY array_position($3::text[],s.stage_key)
             LIMIT 1
          ) AS current_stage ON true
         WHERE ($1::text IS NULL OR p.class_code = $1)
           AND p.source_app_id IS DISTINCT FROM 'codex_fixture'
           AND ($2::text IS NULL OR $2 = ANY(coalesce(nullif(s.teacher_names,ARRAY[]::text[]),t.teacher_names,ARRAY[]::text[])))
           AND p.status<>'superseded'
           AND (registry.class_code IS NULL
  OR coalesce(registry.eligibility_reason,'') <> ALL(ARRAY['excluded','excluded_ic_before_2065','excluded_ic_program','excluded_teacher']::text[]))
           AND ($7::boolean OR registry.class_status IS DISTINCT FROM 'completed')
           AND ($8::text IS NULL OR p.task_type=$8)
           AND ($9::text IS NULL
             OR ($10::boolean AND (p.homework_file_id=$11
               OR writing_flow.normalize_search(s.student_name)
                 LIKE '%' || writing_flow.normalize_search($9) || '%'))
             OR ($12::boolean AND p.pair_id=ANY($13::uuid[])))
           AND ($14::date IS NULL OR
             (CASE WHEN $6::text='delivered' THEN deliver.completed_at
               ELSE coalesce(s.source_created_at,p.created_at) END)
             >= ($14::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'))
           AND ($15::date IS NULL OR
             (CASE WHEN $6::text='delivered' THEN deliver.completed_at
               ELSE coalesce(s.source_created_at,p.created_at) END)
             < (($15::date+1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'))
           AND ($4::text IS NULL OR coalesce(current_stage.stage_key,
                 CASE WHEN p.status='delivered' THEN 'deliver' ELSE 'intake' END)=$4)
           AND ($5::text IS NULL OR coalesce(current_stage.stage_status,
                 CASE WHEN p.status='delivered' THEN 'succeeded' ELSE 'pending' END)=$5)
           AND ($20::text IS NULL OR ($20='test' AND p.source_type='term_test')
             OR ($20='homework' AND p.source_type<>'term_test'))
           AND (($6::text='skipped' AND p.skipped_at IS NOT NULL)
             OR ($6::text='review' AND p.skipped_at IS NULL
               AND (coalesce(current_stage.stage_status,'')='needs_review'
                 OR (p.source_type='term_test' AND history.peer_pair_ids IS NOT NULL)))
             OR ($6::text='delivered' AND p.status='delivered' AND p.skipped_at IS NULL)
             OR ($6::text='unfinished' AND p.status<>'delivered' AND p.skipped_at IS NULL)
             OR ($6::text IS NULL AND p.skipped_at IS NULL))
           AND ($16::timestamptz IS NULL OR (p.updated_at,p.pair_id)<($16::timestamptz,$17::uuid))
         ORDER BY p.updated_at DESC, p.pair_id DESC
         LIMIT $18 OFFSET $19
