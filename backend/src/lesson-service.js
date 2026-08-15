import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { ApiError } from './service.js';

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const meaningfulText = value => String(value ?? '').replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu, '');

function stringArray(value) {
  return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function pick(source, keys) {
  return Object.fromEntries(keys.map(key => [key, typeof source?.[key] === 'string' ? source[key] : '']));
}

export function createLessonPracticeService({ pool, provisionalService = null, now = () => Date.now() }) {
  async function definitions(activityId, client = pool) {
    const result = await client.query(`SELECT section_key AS section, title, sort_order AS "sortOrder",
      input_fields AS "inputFields", context_fields AS "contextFields", required_fields AS "requiredFields",
      validation_mode AS "validationMode"
      FROM writing_practice.activity_section_definition
      WHERE activity_id=$1 ORDER BY sort_order`, [activityId]);
    return result.rows;
  }

  async function sessionDetails(sessionRef, client = pool) {
    const session = await client.query(`SELECT session.id, session.public_id AS "sessionRef",
      session.activity_id AS "activityId", jsonb_strip_nulls(COALESCE(session.response_data,'{}'::jsonb)||jsonb_build_object(
        'overview',session.overview,'body1',session.body1,'body2',session.body2,'draft1',session.draft1,'draft2',session.draft2)) AS responses,
      session.draft_version AS "draftVersion", session.updated_at AS "updatedAt",
      activity.slug AS "activitySlug", activity.title
      FROM writing_practice.activity_session session
      JOIN writing_practice.activity activity ON activity.id=session.activity_id
      WHERE session.public_id=$1`, [sessionRef]);
    if (!session.rowCount) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên làm bài.');
    const row = session.rows[0];
    const [sectionRows, comments, attempts, sectionDefs] = await Promise.all([
      client.query(`SELECT section_key AS section, locked, fail_streak AS "failStreak",
        round_number AS "roundNumber" FROM writing_practice.session_section
        WHERE session_id=$1 ORDER BY section_key`, [row.id]),
      client.query(`SELECT comment.public_id AS "commentRef", attempt.public_id AS "attemptRef",
        comment.section_key AS section, comment.comment_number AS "commentNumber", comment.status,
        comment.content AS feedback, comment.created_at AS "createdAt",
        attempt.result_artifacts AS artifacts,
        (attempt.status='failed' AND attempt.retry_count<3) AS "canRetry"
        FROM writing_practice.comment comment
        JOIN writing_practice.check_attempt attempt ON attempt.id=comment.attempt_id
        WHERE comment.session_id=$1 ORDER BY comment.created_at`, [row.id]),
      client.query(`SELECT public_id AS "attemptRef", section_key AS section,
        comment_number AS "commentNumber", status, result_status AS "resultStatus",
        error_code AS "errorCode", result_artifacts AS artifacts,
        created_at AS "createdAt", completed_at AS "completedAt"
        FROM writing_practice.check_attempt WHERE session_id=$1 ORDER BY created_at DESC`, [row.id]),
      definitions(row.activityId, client)
    ]);
    const sectionStates = Object.fromEntries(sectionRows.rows.map(state => [state.section, {
      status: state.locked ? 'passed' : state.failStreak > 0 ? 'revision' : 'draft',
      locked: state.locked,
      attemptsWithoutPass: state.failStreak,
      roundNumber: state.roundNumber
    }]));
    for (const attempt of attempts.rows) {
      if (['queued', 'leased'].includes(attempt.status) && sectionStates[attempt.section]) sectionStates[attempt.section].status = 'queued';
    }
    return { ...row, sections: sectionStates, sectionDefinitions: sectionDefs, comments: comments.rows, attempts: attempts.rows };
  }

  async function openSession({ activitySlug, classRef, studentRef, accessCode }) {
    const result = await withTransaction(pool, async client => {
      const identity = provisionalService ? await provisionalService.resolveStudent(client, { activitySlug, classRef, studentRef, accessCode, lesson: true }) : null;
      if (identity?.accessError) return { accessError: identity.accessError };
      const roster = identity ? { rowCount: 1, rows: [{ activity_id: identity.activityId, class_id: identity.classId, student_ref: identity.studentRef }] } : await client.query(`SELECT activity.id AS activity_id, scope.id AS class_id, roster.student_public_id AS student_ref
        FROM writing_practice.activity activity
        JOIN writing_practice.activity_class_scope scope ON scope.activity_id=activity.id
          AND scope.public_id=$2 AND scope.status='active' AND scope.end_date>=CURRENT_DATE
        JOIN writing_practice.activity_roster roster ON roster.activity_class_id=scope.id
          AND roster.student_public_id=$3 AND roster.active
        WHERE activity.slug=$1 AND activity.status='active' AND activity.grading_pool<>'task1'
        FOR KEY SHARE`, [activitySlug, classRef, studentRef]);
      if (!roster.rowCount) throw new ApiError(404, 'SESSION_NOT_ALLOWED', 'Học viên không thuộc lớp đang hoạt động.');
      const row = roster.rows[0];
      const canonicalStudentRef = row.student_ref || studentRef;
      const sectionDefs = await definitions(row.activity_id, client);
      if (!sectionDefs.length) throw new ApiError(409, 'LESSON_NOT_CONFIGURED', 'Handout chưa được cấu hình đầy đủ.');
      await client.query(`INSERT INTO writing_practice.activity_session(activity_id,activity_class_id,student_public_id,last_seen_at)
        VALUES($1,$2,$3,now()) ON CONFLICT(activity_id,student_public_id)
        DO UPDATE SET updated_at=now(),last_seen_at=now()`,
      [row.activity_id, row.class_id, canonicalStudentRef]);
      const session = await client.query(`SELECT id,public_id FROM writing_practice.activity_session
        WHERE activity_id=$1 AND student_public_id=$2`, [row.activity_id, canonicalStudentRef]);
      for (const section of sectionDefs) {
        await client.query(`INSERT INTO writing_practice.session_section(session_id,section_key)
          VALUES($1,$2) ON CONFLICT DO NOTHING`, [session.rows[0].id, section.section]);
      }
      return sessionDetails(session.rows[0].public_id, client);
    });
    if (result?.accessError) throw new ApiError(result.accessError.status, result.accessError.code, result.accessError.message);
    return result;
  }

  async function saveResponses({ sessionRef, baseVersion, requestId, responses }) {
    const body = { baseVersion, responses };
    return withTransaction(pool, async client => {
      const session = await client.query(`SELECT id,activity_id,draft_version
        FROM writing_practice.activity_session WHERE public_id=$1 FOR UPDATE`, [sessionRef]);
      if (!session.rowCount) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên làm bài.');
      const sectionDefs = await definitions(session.rows[0].activity_id, client);
      const allowed = new Set(sectionDefs.flatMap(item => stringArray(item.inputFields)));
      if (!allowed.size || Object.keys(responses).some(key => !allowed.has(key))) {
        throw new ApiError(400, 'UNKNOWN_RESPONSE_FIELD', 'Bài làm chứa ô không thuộc handout này.');
      }
      const prior = await client.query(`SELECT body_hash FROM writing_practice.draft_request
        WHERE session_id=$1 AND request_id=$2`, [session.rows[0].id, requestId]);
      if (prior.rowCount) {
        if (prior.rows[0].body_hash !== hash(body)) throw new ApiError(409, 'REQUEST_ID_REUSED', 'Mã lưu đã được dùng cho nội dung khác.');
        return sessionDetails(sessionRef, client);
      }
      if (session.rows[0].draft_version !== baseVersion) {
        throw new ApiError(409, 'DRAFT_VERSION_CONFLICT', 'Bản nháp đã đổi ở nơi khác.', { current: await sessionDetails(sessionRef, client) });
      }
      await client.query(`UPDATE writing_practice.activity_session
        SET response_data=$2::jsonb,draft_version=draft_version+1,updated_at=now(),last_seen_at=now() WHERE id=$1`,
      [session.rows[0].id, JSON.stringify(responses)]);
      await client.query(`INSERT INTO writing_practice.draft_request(session_id,request_id,body_hash,draft_version)
        VALUES($1,$2,$3,$4)`, [session.rows[0].id, requestId, hash(body), baseVersion + 1]);
      return sessionDetails(sessionRef, client);
    });
  }

  async function submitCheck({ sessionRef, section, requestId }) {
    return withTransaction(pool, async client => {
      const session = await client.query(`SELECT id,activity_id,response_data
        FROM writing_practice.activity_session WHERE public_id=$1 FOR UPDATE`, [sessionRef]);
      if (!session.rowCount) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên làm bài.');
      const definition = await client.query(`SELECT input_fields,context_fields,required_fields,validation_mode
        FROM writing_practice.activity_section_definition WHERE activity_id=$1 AND section_key=$2`,
      [session.rows[0].activity_id, section]);
      if (!definition.rowCount) throw new ApiError(409, 'SECTION_NOT_READY', 'Phần này chưa được cấu hình để chấm.');
      const config = definition.rows[0];
      const required = stringArray(config.required_fields);
      const responses = session.rows[0].response_data || {};
      const filled = required.map(key => Boolean(meaningfulText(responses[key])));
      const valid = required.length > 0 && (config.validation_mode === 'any' ? filled.some(Boolean) : filled.every(Boolean));
      if (!valid) throw new ApiError(400, 'EMPTY_SECTION', 'Phần cần kiểm tra chưa có đủ nội dung.');
      const snapshotKeys = [...new Set([...stringArray(config.input_fields), ...stringArray(config.context_fields)])];
      const snapshot = pick(responses, snapshotKeys);
      const state = await client.query(`SELECT locked,round_number FROM writing_practice.session_section
        WHERE session_id=$1 AND section_key=$2 FOR UPDATE`, [session.rows[0].id, section]);
      if (!state.rowCount) throw new ApiError(409, 'SECTION_NOT_READY', 'Phần này chưa sẵn sàng để chấm.');
      if (state.rows[0].locked) throw new ApiError(423, 'SECTION_LOCKED', 'Phần này đã đạt yêu cầu và đã được khóa.');
      const bodyHash = hash({ section, snapshot });
      const prior = await client.query(`SELECT attempt.public_id,attempt.session_id,attempt.section_key,
        attempt.status,attempt.version,attempt.body_hash,attempt.comment_number,
        comment.public_id AS comment_ref
        FROM writing_practice.check_attempt attempt
        JOIN writing_practice.comment comment ON comment.attempt_id=attempt.id
        WHERE attempt.request_id=$1`, [requestId]);
      if (prior.rowCount) {
        const item = prior.rows[0];
        if (item.session_id !== session.rows[0].id || item.section_key !== section || item.body_hash !== bodyHash) {
          throw new ApiError(409, 'REQUEST_ID_REUSED', 'Mã Check đã được dùng cho nội dung khác.');
        }
        return { attemptRef: item.public_id, commentRef: item.comment_ref, status: item.status,
          version: item.version, commentNumber: item.comment_number, section, idempotent: true };
      }
      const active = await client.query(`SELECT attempt.public_id,attempt.status,attempt.version,
        attempt.comment_number,comment.public_id AS comment_ref
        FROM writing_practice.check_attempt attempt
        JOIN writing_practice.comment comment ON comment.attempt_id=attempt.id
        WHERE attempt.session_id=$1 AND attempt.section_key=$2
          AND attempt.status IN ('queued','leased') FOR UPDATE OF attempt`, [session.rows[0].id, section]);
      if (active.rowCount) {
        const item = active.rows[0];
        return { attemptRef: item.public_id, commentRef: item.comment_ref, status: item.status,
          version: item.version, commentNumber: item.comment_number, section, idempotent: true };
      }
      const sequence = await client.query(`SELECT COALESCE(max(comment_number),0)+1 AS next
        FROM writing_practice.check_attempt WHERE session_id=$1 AND section_key=$2`, [session.rows[0].id, section]);
      const commentNumber = sequence.rows[0].next;
      const inserted = await client.query(`INSERT INTO writing_practice.check_attempt
        (session_id,section_key,round_number,comment_number,request_id,body_hash,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id,public_id,status,version`,
      [session.rows[0].id, section, state.rows[0].round_number, commentNumber, requestId, bodyHash, JSON.stringify(snapshot)]);
      const comment = await client.query(`INSERT INTO writing_practice.comment
        (attempt_id,session_id,section_key,comment_number,status,content)
        VALUES($1,$2,$3,$4,'queued','Đang chấm') RETURNING public_id`,
      [inserted.rows[0].id, session.rows[0].id, section, commentNumber]);
      return { attemptRef: inserted.rows[0].public_id, commentRef: comment.rows[0].public_id,
        status: inserted.rows[0].status, version: inserted.rows[0].version,
        commentNumber, section, idempotent: false };
    });
  }

  async function publishLive({ sessionRef, activeField }) {
    const session = await pool.query(`SELECT session.id,session.activity_id
      FROM writing_practice.activity_session session WHERE session.public_id=$1`, [sessionRef]);
    if (!session.rowCount) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên làm bài.');
    if (activeField) {
      const sectionDefs = await definitions(session.rows[0].activity_id);
      const allowed = new Set(sectionDefs.flatMap(item => stringArray(item.inputFields)));
      if (!allowed.has(activeField)) throw new ApiError(400, 'UNKNOWN_ACTIVE_FIELD', 'Ô đang viết không hợp lệ.');
    }
    await pool.query(`UPDATE writing_practice.activity_session
      SET last_seen_at=now(),active_field=$2 WHERE id=$1`, [session.rows[0].id, activeField || null]);
    return { accepted: true };
  }

  async function listLive({ activitySlug, classRef }) {
    const [activityResult, roster] = await Promise.all([
      pool.query(`SELECT activity.id,activity.grading_pool AS "gradingPool" FROM writing_practice.activity activity
        WHERE activity.slug=$1 AND activity.status='active'`, [activitySlug]),
      pool.query(`SELECT session.public_id AS "sessionRef",
      scope.public_id AS "classRef", scope.class_name_snapshot AS "className",
      roster.student_public_id AS "studentRef", roster.display_alias AS "displayName",
      jsonb_strip_nulls(COALESCE(session.response_data,'{}'::jsonb)||jsonb_build_object(
        'overview',session.overview,'body1',session.body1,'body2',session.body2,'draft1',session.draft1,'draft2',session.draft2)) AS responses,
      session.updated_at AS "savedAt",
      session.last_seen_at AS "lastSeenAt", session.active_field AS "activeField",
      (provisional.status='pending') AS provisional,
      COALESCE(provisional.status,'official') AS "reconciliationStatus",
      COALESCE(section_summary.sections,'{}'::jsonb) AS sections,
      COALESCE(attempt_summary.check_count,0)::int AS "checkCount",
      COALESCE(attempt_summary.attempted_section_count,0)::int AS "attemptedSectionCount",
      COALESCE(support_summary.support_sections,'[]'::jsonb) AS "supportSections"
      FROM writing_practice.activity activity
      JOIN writing_practice.activity_class_scope scope ON scope.activity_id=activity.id AND scope.status='active'
      JOIN writing_practice.activity_roster roster ON roster.activity_class_id=scope.id AND roster.active
      LEFT JOIN writing_practice.activity_student_alias identity_alias ON identity_alias.activity_class_id=scope.id
        AND identity_alias.alias_student_public_id=roster.student_public_id
      LEFT JOIN writing_practice.provisional_student provisional ON provisional.activity_class_id=scope.id
        AND provisional.student_public_id=COALESCE(identity_alias.canonical_student_public_id,roster.student_public_id)
      LEFT JOIN writing_practice.activity_session session ON session.activity_id=activity.id
        AND session.student_public_id=COALESCE(identity_alias.canonical_student_public_id,roster.student_public_id)
      LEFT JOIN LATERAL (
        SELECT jsonb_object_agg(section.section_key,jsonb_build_object(
          'status',CASE WHEN section.locked THEN 'passed'
            WHEN EXISTS(SELECT 1 FROM writing_practice.check_attempt active
              WHERE active.session_id=section.session_id AND active.section_key=section.section_key
                AND active.status IN ('queued','leased')) THEN 'queued'
            WHEN latest_failed.public_id IS NOT NULL THEN 'technical_error'
            WHEN section.fail_streak>0 THEN 'revision' ELSE 'draft' END,
          'attemptsWithoutPass',section.fail_streak,
          'roundNumber',section.round_number,
          'technicalAttemptRef',latest_failed.public_id,
          'technicalRetryCount',latest_failed.retry_count)) AS sections
        FROM writing_practice.session_section section
        LEFT JOIN LATERAL (
          SELECT failed.public_id,failed.retry_count
          FROM writing_practice.check_attempt failed
          WHERE failed.session_id=section.session_id
            AND failed.section_key=section.section_key
            AND failed.status='failed'
          ORDER BY failed.created_at DESC LIMIT 1
        ) latest_failed ON true
        WHERE section.session_id=session.id
      ) section_summary ON true
      LEFT JOIN LATERAL (
        SELECT count(*) AS check_count,count(DISTINCT attempt.section_key) AS attempted_section_count FROM writing_practice.check_attempt attempt
        WHERE attempt.session_id=session.id
      ) attempt_summary ON true
      LEFT JOIN LATERAL (
        SELECT jsonb_agg(jsonb_build_object('section',state.section_key,'commentNumber',state.fail_streak,
          'warningAt',warning.completed_at) ORDER BY state.fail_streak DESC,warning.completed_at) AS support_sections
        FROM writing_practice.session_section state
        JOIN LATERAL (SELECT attempt.comment_number,attempt.completed_at
          FROM writing_practice.check_attempt attempt WHERE attempt.session_id=state.session_id
            AND attempt.section_key=state.section_key AND attempt.round_number=state.round_number
            AND attempt.status='completed' AND attempt.result_status='needs_revision'
          ORDER BY attempt.completed_at DESC LIMIT 1) warning ON true
        WHERE state.session_id=session.id AND NOT state.locked AND state.fail_streak>0 AND state.fail_streak%3=0
      ) support_summary ON true
      WHERE activity.slug=$1 AND activity.status='active'
        AND ($2::uuid IS NULL OR scope.public_id=$2::uuid)
      ORDER BY scope.class_name_snapshot,roster.display_alias`, [activitySlug, classRef || null])
    ]);
    if (!activityResult.rowCount) throw new ApiError(404, 'ACTIVITY_NOT_FOUND', 'Hoạt động chưa được mở.');
    const activity = activityResult.rows[0];
    const sectionDefs = activity.gradingPool === 'task1' ? [
      { section: 'overview', requiredFields: ['overview'] },
      { section: 'outline', requiredFields: ['body1', 'body2'] },
      { section: 'draft', requiredFields: ['draft1', 'draft2'] }
    ] : await definitions(activity.id);
    const requiredFields = [...new Set(sectionDefs.flatMap(item => stringArray(item.requiredFields)))];
    const cutoff = now() - 60_000;
    const students = roster.rows.map(student => {
      const responses = student.responses || {};
      const filledFields = requiredFields.filter(field => Boolean(meaningfulText(responses[field]))).length;
      const sections = student.sections || {};
      const passedSectionCount = Object.values(sections).filter(item => item.status === 'passed').length;
      const attemptedSectionCount = Number(student.attemptedSectionCount || 0);
      const hasStarted = filledFields > 0 || Number(student.checkCount) > 0;
      const supportSections = student.supportSections || [];
      return { ...student, responses, sections, filledFields, totalFields: requiredFields.length,
        progressPercent: requiredFields.length ? Math.round(filledFields * 100 / requiredFields.length) : 0,
        passedSectionCount, attemptedSectionCount, hasStarted,
        supportRequired: supportSections.length > 0, supportSections,
        online: Boolean(student.lastSeenAt && Date.parse(student.lastSeenAt) >= cutoff) };
    });
    return { activitySlug, generatedAt: new Date(now()).toISOString(), students };
  }

  async function retryFailedAttempt({ attemptRef, actorRef }) {
    return withTransaction(pool, async client => {
      const attempt = await client.query(`SELECT attempt.id,attempt.public_id,attempt.session_id,
        attempt.section_key,attempt.comment_number,attempt.status,state.locked
        FROM writing_practice.check_attempt attempt
        JOIN writing_practice.session_section state ON state.session_id=attempt.session_id
          AND state.section_key=attempt.section_key
        WHERE attempt.public_id=$1 FOR UPDATE OF attempt,state`, [attemptRef]);
      if (!attempt.rowCount) throw new ApiError(404, 'ATTEMPT_NOT_FOUND', 'Không tìm thấy lượt chấm.');
      const row = attempt.rows[0];
      if (['queued', 'leased'].includes(row.status)) {
        return { attemptRef: row.public_id, section: row.section_key, commentNumber: row.comment_number, status: row.status, idempotent: true };
      }
      if (row.status !== 'failed' || row.locked) {
        throw new ApiError(409, 'ATTEMPT_NOT_ADMIN_RETRYABLE', 'Lượt chấm này không thể xếp lại.');
      }
      const active = await client.query(`SELECT 1 FROM writing_practice.check_attempt
        WHERE session_id=$1 AND section_key=$2 AND status IN ('queued','leased')`, [row.session_id, row.section_key]);
      if (active.rowCount) throw new ApiError(409, 'SECTION_ALREADY_QUEUED', 'Phần này đã có một lượt đang chấm.');
      await client.query(`UPDATE writing_practice.check_attempt
        SET status='queued',retry_count=0,error_code=NULL,worker_id=NULL,lease_token=NULL,
          lease_expires_at=NULL,completed_at=NULL,version=version+1,updated_at=now()
        WHERE id=$1`, [row.id]);
      await client.query(`UPDATE writing_practice.comment
        SET status='queued',content='Đang chấm' WHERE attempt_id=$1`, [row.id]);
      await client.query(`INSERT INTO writing_practice.admin_audit_event
        (session_id,section_key,action,actor_ref,reason)
        VALUES($1,$2,'retry_failed_attempt',$3,$4)`,
      [row.session_id, row.section_key, actorRef, 'Giảng viên xếp chấm lại sau lỗi kỹ thuật.']);
      return { attemptRef: row.public_id, section: row.section_key, commentNumber: row.comment_number, status: 'queued', idempotent: false };
    });
  }

  async function reopenSection({ sessionRef, section, actorRef, reason }) {
    return withTransaction(pool, async client => {
      const session = await client.query(`SELECT id FROM writing_practice.activity_session
        WHERE public_id=$1 FOR UPDATE`, [sessionRef]);
      if (!session.rowCount) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên làm bài.');
      const state = await client.query(`UPDATE writing_practice.session_section
        SET locked=false,fail_streak=0,round_number=round_number+1,updated_at=now()
        WHERE session_id=$1 AND section_key=$2 AND locked=true RETURNING round_number`,
      [session.rows[0].id, section]);
      if (!state.rowCount) throw new ApiError(409, 'SECTION_NOT_LOCKED', 'Phần này hiện không bị khóa.');
      await client.query(`INSERT INTO writing_practice.admin_audit_event
        (session_id,section_key,action,actor_ref,reason)
        VALUES($1,$2,'reopen_section',$3,$4)`, [session.rows[0].id, section, actorRef, reason]);
      return sessionDetails(sessionRef, client);
    });
  }

  return { openSession, sessionDetails, saveResponses, submitCheck, publishLive, listLive, retryFailedAttempt, reopenSection };
}
