// The caller authenticates the teacher and authorizes the activity/class pair.
// Only presence markers and aggregate counts leave this endpoint.
export async function readLesson9Overview(pool, activitySlug, classRef) {
  const {rows} = await pool.query(`
    WITH scoped AS MATERIALIZED (
      SELECT s.id, s.public_id AS "sessionRef", s.student_public_id AS "studentRef",
        s.updated_at AS "updatedAt", ui.ui_version AS "uiVersion", ui.data AS "uiData",
        jsonb_strip_nulls(jsonb_build_object(
          'overview',s.overview,'body1',s.body1,'body2',s.body2,'draft1',s.draft1,'draft2',s.draft2
        ) || COALESCE(s.response_data,'{}'::jsonb)) AS responses
      FROM writing_practice.activity_session s
      JOIN writing_practice.activity a ON a.id=s.activity_id AND a.slug=$1 AND a.status='active'
      JOIN writing_practice.activity_class_scope c ON c.id=s.activity_class_id
        AND c.activity_id=a.id AND c.public_id=$2 AND c.status='active'
      LEFT JOIN writing_practice.lesson9_session_state ui ON ui.session_id=s.id
    ), attempt_state AS (
      SELECT a.session_id, a.section_key, bool_or(a.status IN ('queued','leased')) AS pending,
        (array_agg(a.status ORDER BY a.created_at DESC, a.id DESC))[1] AS latest
      FROM writing_practice.check_attempt a JOIN scoped s ON s.id=a.session_id
      GROUP BY a.session_id,a.section_key
    ), draft_pass AS (
      SELECT DISTINCT ON (a.session_id) a.session_id,a.snapshot
      FROM writing_practice.check_attempt a JOIN scoped s ON s.id=a.session_id
      WHERE a.section_key='draft' AND a.status='completed' AND a.result_status='passed'
      ORDER BY a.session_id,a.created_at DESC,a.id DESC
    ), history AS (
      SELECT c.session_id,c.section_key,count(*)::int AS checks,
        count(*) FILTER (WHERE COALESCE(a.result_status,c.status)='needs_revision')::int AS negatives,
        count(*) FILTER (WHERE NOT starts_with(c.content,'Học viên tự'))::int AS ai
      FROM writing_practice.comment c
      JOIN scoped s ON s.id=c.session_id
      JOIN writing_practice.check_attempt a ON a.id=c.attempt_id
      WHERE COALESCE(a.result_status,c.status) IN ('passed','needs_revision')
      GROUP BY c.session_id,c.section_key
    ), steps AS (
      SELECT s.id,jsonb_object_agg(k.section,jsonb_build_object(
        'status',CASE WHEN ast.latest='failed' AND NOT COALESCE(section.locked,false) THEN 'technical_error'
          WHEN ast.pending THEN 'pending' WHEN section.locked THEN 'passed'
          WHEN section.fail_streak>0 THEN 'revision' ELSE 'draft' END,
        'locked',COALESCE(section.locked,false),
        'checks',COALESCE(h.checks,0),'negatives',COALESCE(h.negatives,0),'ai',COALESCE(h.ai,0)
      )) AS data
      FROM scoped s
      CROSS JOIN (VALUES ('topic_sentence'),('supporting_idea_1'),('supporting_idea_2'),('draft')) k(section)
      LEFT JOIN writing_practice.session_section section ON section.session_id=s.id AND section.section_key=k.section
      LEFT JOIN attempt_state ast ON ast.session_id=s.id AND ast.section_key=k.section
      LEFT JOIN history h ON h.session_id=s.id AND h.section_key=k.section
      GROUP BY s.id
    ), open_threads AS (
      SELECT t.session_id,count(*)::int AS count
      FROM writing_practice.teacher_comment_thread t JOIN scoped s ON s.id=t.session_id
      WHERE t.status<>'addressed'
        AND EXISTS(SELECT 1 FROM writing_practice.teacher_comment_message m WHERE m.thread_id=t.id)
      GROUP BY t.session_id
    )
    SELECT s.*, steps.data AS steps,COALESCE(t.count,0) AS "openThreads",
      pass.session_id IS NOT NULL AND (
        pass.snapshot->'draft1' IS DISTINCT FROM s.responses->'draft1'
        OR pass.snapshot->'draft2' IS DISTINCT FROM s.responses->'draft2'
      ) AS "draftEdited"
    FROM scoped s JOIN steps ON steps.id=s.id
    LEFT JOIN draft_pass pass ON pass.session_id=s.id
    LEFT JOIN open_threads t ON t.session_id=s.id
  `, [activitySlug, classRef]);

  return rows.map(row => ({
    studentRef:row.studentRef, sessionRef:row.sessionRef, classRef, updatedAt:row.updatedAt,
    responses:Object.fromEntries(Object.entries(row.responses).map(([field,value]) => [
      field, field==='body_choice' ? (value==='body2'?'body2':value?'body1':'')
        : typeof value==='string' ? (value.trim()?'x':value?' ':'') : value?'x':''
    ])),
    steps:row.steps, openThreads:row.openThreads, draftEdited:row.draftEdited,
    idea2Open:row.uiVersion && row.uiVersion!=='legacy-v1' ? !!row.uiData?.idea2Opened
      : row.steps.supporting_idea_1.status==='passed'||!!row.responses.idea2_a,
    editedFields:row.uiData?.editedFields||[],
    approvals:Object.keys(row.uiData?.approvals||{}).filter(key=>!!row.uiData.approvals[key]),
  }));
}
