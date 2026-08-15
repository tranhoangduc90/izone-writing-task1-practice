import crypto from 'node:crypto';
import { withTransaction } from './db.js';

export class ApiError extends Error {
  constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); }
}
const sections = ['overview', 'outline', 'draft'];
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const meaningfulText = value => String(value ?? '').replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu, '');
const draftLeaseSeconds = 1200;
function normalizeLmsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && url.hostname.toLowerCase() === 'practice.izone.edu.vn'
      && url.pathname.startsWith('/shared/writing-essays/')
      ? url.href
      : null;
  } catch { return null; }
}

export function createWritingPracticeService({ pool, provisionalService = null }) {
  async function getRoster(slug) {
    const activity = await pool.query(`SELECT id, slug, title FROM writing_practice.activity WHERE slug = $1 AND status = 'active'`, [slug]);
    if (!activity.rowCount) throw new ApiError(404, 'ACTIVITY_NOT_FOUND', 'Hoạt động chưa được mở.');
    const rows = await pool.query(`SELECT class.public_id AS class_ref, class.class_name_snapshot, roster.student_public_id AS student_ref,
      roster.display_name, roster.display_alias, (provisional.status='pending') AS provisional,
      (provisional.status='pending') AS requires_access_code FROM writing_practice.activity_class_scope class
      LEFT JOIN writing_practice.activity_roster roster ON roster.activity_class_id = class.id AND roster.active
      LEFT JOIN writing_practice.provisional_student provisional ON provisional.activity_class_id=class.id
        AND provisional.student_public_id=roster.student_public_id
      WHERE class.activity_id = $1 AND class.status='active' AND class.end_date >= CURRENT_DATE ORDER BY class.class_name_snapshot, roster.display_name, roster.display_alias`, [activity.rows[0].id]);
    const classes = new Map();
    for (const row of rows.rows) {
      if (!classes.has(row.class_ref)) classes.set(row.class_ref, { classRef: row.class_ref, className: row.class_name_snapshot, students: [] });
      if (row.student_ref) classes.get(row.class_ref).students.push({ studentRef: row.student_ref, displayName: row.display_name, alias: row.display_alias,
        provisional: Boolean(row.provisional), requiresAccessCode: Boolean(row.requires_access_code) });
    }
    return { activity: { slug: activity.rows[0].slug, title: activity.rows[0].title }, classes: [...classes.values()] };
  }
  async function sessionDetails(sessionRef, client = pool) {
    const session = await client.query(`SELECT s.id, s.public_id AS "sessionRef", s.overview, s.body1, s.body2, s.draft1, s.draft2,
      s.draft2_unlocked AS "draft2Unlocked", s.draft_version AS "draftVersion", s.updated_at AS "updatedAt"
      FROM writing_practice.activity_session s WHERE s.public_id = $1`, [sessionRef]);
    if (!session.rowCount) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên làm bài.');
    // Một pg Client chỉ chạy an toàn một truy vấn tại một thời điểm. Đọc tuần tự để tránh
    // lỗi ngẫu nhiên khi sessionDetails chạy bên trong transaction mở/lưu/check.
    const sectionRows = await client.query(`SELECT section_key AS section, locked, fail_streak AS "failStreak", round_number AS "roundNumber" FROM writing_practice.session_section WHERE session_id = $1 ORDER BY section_key`, [session.rows[0].id]);
    const comments = await client.query(`SELECT comment.public_id AS "commentRef", attempt.public_id AS "attemptRef", comment.section_key AS section,
        comment.comment_number AS "commentNumber", comment.status, comment.content AS feedback, comment.created_at AS "createdAt",
        attempt.result_artifacts AS artifacts,
        (attempt.status='failed' AND attempt.retry_count<3) AS "canRetry"
        FROM writing_practice.comment comment JOIN writing_practice.check_attempt attempt ON attempt.id=comment.attempt_id
        WHERE comment.session_id = $1 ORDER BY comment.created_at`, [session.rows[0].id]);
    const attempts = await client.query(`SELECT public_id AS "attemptRef", section_key AS section, comment_number AS "commentNumber", status, result_status AS "resultStatus", error_code AS "errorCode", created_at AS "createdAt", completed_at AS "completedAt" FROM writing_practice.check_attempt WHERE session_id = $1 ORDER BY created_at DESC`, [session.rows[0].id]);
    const sectionStates = Object.fromEntries(sectionRows.rows.map(row => [row.section, {
      status: row.locked ? 'passed' : row.failStreak > 0 ? 'revision' : 'draft',
      locked: row.locked,
      failStreak: row.failStreak,
      attemptsWithoutPass: row.failStreak,
      roundNumber: row.roundNumber
    }]));
    for (const attempt of attempts.rows) {
      if (['queued', 'leased'].includes(attempt.status) && sectionStates[attempt.section]) sectionStates[attempt.section].status = 'queued';
    }
    return { ...session.rows[0], sections: sectionStates, comments: comments.rows, attempts: attempts.rows };
  }
  async function openSession({ activitySlug, classRef, studentRef, accessCode }) {
    const result = await withTransaction(pool, async client => {
      const identity = provisionalService ? await provisionalService.resolveStudent(client, { activitySlug, classRef, studentRef, accessCode }) : null;
      if (identity?.accessError) return { accessError: identity.accessError };
      const roster = identity ? { rowCount: 1, rows: [{ activity_id: identity.activityId, class_id: identity.classId, student_ref: identity.studentRef }] } : await client.query(`SELECT a.id AS activity_id, c.id AS class_id, r.student_public_id AS student_ref FROM writing_practice.activity a
        JOIN writing_practice.activity_class_scope c ON c.activity_id = a.id AND c.public_id = $2 AND c.status='active' AND c.end_date >= CURRENT_DATE
        JOIN writing_practice.activity_roster r ON r.activity_class_id = c.id AND r.student_public_id = $3 AND r.active
        WHERE a.slug = $1 AND a.status = 'active' AND a.grading_pool='task1' FOR KEY SHARE`, [activitySlug, classRef, studentRef]);
      if (!roster.rowCount) throw new ApiError(404, 'SESSION_NOT_ALLOWED', 'Học viên không thuộc lớp đang hoạt động.');
      const row = roster.rows[0];
      const canonicalStudentRef = row.student_ref || studentRef;
      await client.query(`INSERT INTO writing_practice.activity_session(activity_id, activity_class_id, student_public_id,last_seen_at)
        VALUES($1,$2,$3,now()) ON CONFLICT(activity_id, student_public_id) DO UPDATE SET updated_at=now(),last_seen_at=now()`, [row.activity_id, row.class_id, canonicalStudentRef]);
      const session = await client.query(`SELECT id FROM writing_practice.activity_session WHERE activity_id=$1 AND student_public_id=$2`, [row.activity_id, canonicalStudentRef]);
      for (const section of sections) await client.query(`INSERT INTO writing_practice.session_section(session_id,section_key) VALUES($1,$2) ON CONFLICT DO NOTHING`, [session.rows[0].id, section]);
      return sessionDetails((await client.query(`SELECT public_id FROM writing_practice.activity_session WHERE id=$1`, [session.rows[0].id])).rows[0].public_id, client);
    });
    if (result?.accessError) throw new ApiError(result.accessError.status, result.accessError.code, result.accessError.message);
    return result;
  }
  async function saveDraft({ sessionRef, baseVersion, requestId, overview, body1, body2, draft1, draft2, draft2Unlocked }) {
    const body = { overview, body1, body2, draft1, draft2, draft2Unlocked, baseVersion };
    return withTransaction(pool, async client => {
      const session = await client.query(`SELECT id, draft_version FROM writing_practice.activity_session WHERE public_id=$1 FOR UPDATE`, [sessionRef]);
      if (!session.rowCount) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên làm bài.');
      const prior = await client.query(`SELECT body_hash, draft_version FROM writing_practice.draft_request WHERE session_id=$1 AND request_id=$2`, [session.rows[0].id, requestId]);
      if (prior.rowCount) {
        if (prior.rows[0].body_hash !== hash(body)) throw new ApiError(409, 'REQUEST_ID_REUSED', 'Mã lưu đã được dùng cho nội dung khác.');
        return sessionDetails(sessionRef, client);
      }
      if (session.rows[0].draft_version !== baseVersion) throw new ApiError(409, 'DRAFT_VERSION_CONFLICT', 'Bản nháp đã đổi ở nơi khác.', { current: await sessionDetails(sessionRef, client) });
      await client.query(`UPDATE writing_practice.activity_session SET overview=$2, body1=$3, body2=$4,
        draft1=COALESCE($5,draft1), draft2=COALESCE($6,draft2), draft2_unlocked=draft2_unlocked OR COALESCE($7,false),
        draft_version=draft_version+1,updated_at=now(),last_seen_at=now() WHERE id=$1`, [session.rows[0].id, overview, body1, body2, draft1 ?? null, draft2 ?? null, draft2Unlocked ?? null]);
      await client.query(`INSERT INTO writing_practice.draft_request(session_id,request_id,body_hash,draft_version) VALUES($1,$2,$3,$4)`, [session.rows[0].id, requestId, hash(body), baseVersion + 1]);
      return sessionDetails(sessionRef, client);
    });
  }
  async function submitCheck({ sessionRef, section, requestId, snapshot }) {
    if ((section === 'overview' && !meaningfulText(snapshot.overview))
      || (section === 'outline' && !meaningfulText(snapshot.body1) && !meaningfulText(snapshot.body2))
      || (section === 'draft' && (!meaningfulText(snapshot.draft1) || !meaningfulText(snapshot.draft2)))) throw new ApiError(400, 'EMPTY_SECTION', 'Phần cần kiểm tra không được để trống.');
    return withTransaction(pool, async client => {
      const session = await client.query(`SELECT id,draft1,draft2,draft2_unlocked FROM writing_practice.activity_session WHERE public_id=$1 FOR UPDATE`, [sessionRef]);
      if (!session.rowCount) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên làm bài.');
      await client.query(`UPDATE writing_practice.activity_session SET last_seen_at=now() WHERE id=$1`, [session.rows[0].id]);
      if (section === 'draft') {
        const prerequisites = await client.query(`SELECT section_key,locked FROM writing_practice.session_section WHERE session_id=$1 AND section_key IN ('overview','outline') FOR SHARE`, [session.rows[0].id]);
        if (prerequisites.rowCount !== 2 || prerequisites.rows.some(row => !row.locked)) throw new ApiError(409, 'DRAFT_PREREQUISITES_NOT_PASSED', 'Cần đạt Overview và Outline trước khi Check Draft 2.');
        if (!session.rows[0].draft2_unlocked) throw new ApiError(409, 'DRAFT2_NOT_UNLOCKED', 'Cần hoàn thành Draft 1 và mở Draft 2 trước.');
        if (!meaningfulText(session.rows[0].draft1) || !meaningfulText(session.rows[0].draft2)) throw new ApiError(400, 'EMPTY_SECTION', 'Draft 1 và Draft 2 không được để trống.');
        if (session.rows[0].draft1 !== snapshot.draft1 || session.rows[0].draft2 !== snapshot.draft2) throw new ApiError(409, 'DRAFT_NOT_SAVED', 'Hãy lưu bản Draft mới nhất trước khi Check.');
      }
      const sectionState = await client.query(`SELECT locked,round_number FROM writing_practice.session_section WHERE session_id=$1 AND section_key=$2 FOR UPDATE`, [session.rows[0].id, section]);
      if (!sectionState.rowCount) throw new ApiError(409, 'SECTION_NOT_READY', 'Phần này chưa sẵn sàng để chấm.');
      if (sectionState.rows[0].locked) throw new ApiError(423, 'SECTION_LOCKED', 'Phần này đã đạt yêu cầu và đã được khóa.');
      const bodyHash = hash({ section, snapshot });
      const prior = await client.query(`SELECT attempt.public_id,attempt.session_id,attempt.section_key,attempt.status,attempt.version,
        attempt.body_hash,attempt.comment_number,comment.public_id AS comment_ref
        FROM writing_practice.check_attempt attempt JOIN writing_practice.comment comment ON comment.attempt_id=attempt.id
        WHERE attempt.request_id=$1`, [requestId]);
      if (prior.rowCount) {
        if (prior.rows[0].session_id !== session.rows[0].id || prior.rows[0].section_key !== section || prior.rows[0].body_hash !== bodyHash) {
          throw new ApiError(409, 'REQUEST_ID_REUSED', 'Mã Check đã được dùng cho nội dung khác.');
        }
        return { attemptRef: prior.rows[0].public_id, commentRef: prior.rows[0].comment_ref, status: prior.rows[0].status, version: prior.rows[0].version, commentNumber: prior.rows[0].comment_number, section, idempotent: true };
      }
      const active = await client.query(`SELECT attempt.public_id,attempt.status,attempt.version,attempt.comment_number,comment.public_id AS comment_ref
        FROM writing_practice.check_attempt attempt JOIN writing_practice.comment comment ON comment.attempt_id=attempt.id
        WHERE attempt.session_id=$1 AND attempt.section_key=$2 AND attempt.status IN ('queued','leased') FOR UPDATE OF attempt`, [session.rows[0].id, section]);
      if (active.rowCount) return { attemptRef: active.rows[0].public_id, commentRef: active.rows[0].comment_ref, status: active.rows[0].status, version: active.rows[0].version, commentNumber: active.rows[0].comment_number, section, idempotent: true };
      const sequence = await client.query(`SELECT COALESCE(max(comment_number),0)+1 AS next FROM writing_practice.check_attempt WHERE session_id=$1 AND section_key=$2`, [session.rows[0].id, section]);
      const commentNumber = sequence.rows[0].next;
      const inserted = await client.query(`INSERT INTO writing_practice.check_attempt(session_id,section_key,round_number,comment_number,request_id,body_hash,snapshot)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb) RETURNING id,public_id,status,version`, [session.rows[0].id, section, sectionState.rows[0].round_number, commentNumber, requestId, bodyHash, JSON.stringify(snapshot)]);
      const comment = await client.query(`INSERT INTO writing_practice.comment(attempt_id,session_id,section_key,comment_number,status,content)
        VALUES($1,$2,$3,$4,'queued','Đang chấm') RETURNING public_id`, [inserted.rows[0].id, session.rows[0].id, section, commentNumber]);
      return { attemptRef: inserted.rows[0].public_id, commentRef: comment.rows[0].public_id, status: inserted.rows[0].status, version: inserted.rows[0].version, commentNumber, section, idempotent: false };
    });
  }
  async function getAttempt(attemptRef) {
    const result = await pool.query(`SELECT attempt.public_id AS "attemptRef",attempt.section_key AS section,attempt.comment_number AS "commentNumber",
      attempt.status,attempt.result_status AS "resultStatus",attempt.feedback,attempt.error_code AS "errorCode",attempt.retry_count AS "retryCount",attempt.version,attempt.updated_at AS "updatedAt",
      attempt.result_artifacts AS artifacts,
      state.fail_streak AS "attemptsWithoutPass",comment.public_id AS "commentRef",comment.status AS "commentStatus",comment.content AS "commentContent",comment.created_at AS "commentCreatedAt"
      FROM writing_practice.check_attempt attempt
      JOIN writing_practice.session_section state ON state.session_id=attempt.session_id AND state.section_key=attempt.section_key
      JOIN writing_practice.comment comment ON comment.attempt_id=attempt.id
      WHERE attempt.public_id=$1`, [attemptRef]);
    if (!result.rowCount) throw new ApiError(404, 'ATTEMPT_NOT_FOUND', 'Không tìm thấy lượt kiểm tra.');
    const row = result.rows[0];
    const canRetry = row.status === 'failed' && row.retryCount < 3;
    return { ...row, canRetry, supportWarning: row.resultStatus === 'needs_revision' && row.attemptsWithoutPass > 0 && row.attemptsWithoutPass % 3 === 0,
      comment: { commentRef: row.commentRef, attemptRef: row.attemptRef, section: row.section, commentNumber: row.commentNumber, status: row.commentStatus, feedback: row.commentContent, artifacts: row.artifacts, createdAt: row.commentCreatedAt, canRetry } };
  }
  async function publishLive({ sessionRef }) {
    const result = await pool.query(`UPDATE writing_practice.activity_session SET last_seen_at=now()
      WHERE public_id=$1 RETURNING public_id`, [sessionRef]);
    if (!result.rowCount) throw new ApiError(404, 'SESSION_NOT_FOUND', 'Không tìm thấy phiên làm bài.');
    return { accepted: true };
  }
  async function claimJobs({ workerId, maxJobs, leaseSeconds, workerPool = 'task1' }) {
    return withTransaction(pool, async client => {
      const result = await client.query(`WITH picked AS (SELECT attempt.id FROM writing_practice.check_attempt attempt
        JOIN writing_practice.activity_session session ON session.id=attempt.session_id
        JOIN writing_practice.activity activity ON activity.id=session.activity_id
        WHERE attempt.status='queued' AND attempt.retry_count<3
          AND activity.grading_pool=$4
        ORDER BY attempt.created_at FOR UPDATE OF attempt SKIP LOCKED
        LIMIT $1::int)
      UPDATE writing_practice.check_attempt a SET status='leased',worker_id=$2,lease_token=gen_random_uuid(),
        lease_expires_at=now()+((CASE WHEN a.section_key='draft' THEN ${draftLeaseSeconds} ELSE $3 END)::text||' seconds')::interval,
        retry_count=retry_count+1,version=version+1,updated_at=now() FROM picked
      WHERE a.id=picked.id RETURNING a.id,a.public_id,a.section_key,a.comment_number,a.snapshot,a.lease_token,a.lease_expires_at,a.session_id`, [maxJobs, workerId, leaseSeconds, workerPool]);
      const jobs=[]; for (const row of result.rows) { const context=await client.query(`SELECT activity.task_prompt,activity.prompt_registry_key,
        COALESCE(definition.prompt_record_ref,activity.prompt_record_ref) prompt_record_ref,
        COALESCE(definition.prompt_version,activity.prompt_version) prompt_version,
        COALESCE(jsonb_agg(jsonb_build_object('commentNumber',comment.comment_number,'content',comment.content,'createdAt',comment.created_at)
          ORDER BY comment.comment_number) FILTER(WHERE comment.id IS NOT NULL),'[]') history
        FROM writing_practice.activity_session session
        JOIN writing_practice.activity activity ON activity.id=session.activity_id
        LEFT JOIN writing_practice.activity_section_definition definition
          ON definition.activity_id=activity.id AND definition.section_key=$2
        LEFT JOIN writing_practice.comment comment ON comment.session_id=session.id
          AND comment.section_key=$2 AND comment.status='completed'
        WHERE session.id=$1
        GROUP BY activity.task_prompt,activity.prompt_registry_key,activity.prompt_record_ref,
          activity.prompt_version,definition.prompt_record_ref,definition.prompt_version`,[row.session_id,row.section_key]); jobs.push({jobRef:row.public_id,attemptRef:row.public_id,section:row.section_key,commentNumber:row.comment_number,studentInput:row.snapshot,snapshot:row.snapshot,leaseToken:row.lease_token,leaseExpiresAt:row.lease_expires_at,taskPrompt:context.rows[0].task_prompt,feedbackHistory:context.rows[0].history,promptRegistryKey:context.rows[0].prompt_registry_key,promptRecordId:context.rows[0].prompt_record_ref,promptVersion:context.rows[0].prompt_version,workerPool}); }
      return jobs;
    });
  }
  async function completeJob({ jobRef, leaseToken, resultStatus, feedback, artifacts = {} }) {
    const rawLmsUrl = artifacts?.lmsUrl;
    const lmsUrl = rawLmsUrl ? normalizeLmsUrl(rawLmsUrl) : null;
    if (rawLmsUrl && !lmsUrl) throw new ApiError(400, 'INVALID_LMS_URL', 'Link kết quả LMS không hợp lệ.');
    const storedArtifacts = lmsUrl ? { ...artifacts, lmsUrl } : artifacts;
    const storedFeedback = lmsUrl || feedback;
    return withTransaction(pool, async client => {
    const attempt=await client.query(`UPDATE writing_practice.check_attempt SET status='completed',result_status=$3,feedback=$4,
      result_artifacts=$5::jsonb,completed_at=now(),lease_token=NULL,lease_expires_at=NULL,
      version=version+1,updated_at=now()
      WHERE public_id=$1 AND lease_token=$2 AND status='leased' AND lease_expires_at>now()
      RETURNING id,session_id,section_key,version`,[jobRef,leaseToken,resultStatus,storedFeedback,JSON.stringify(storedArtifacts)]);
    if(!attempt.rowCount) throw new ApiError(409,'LEASE_NOT_OWNED','Công việc không còn thuộc tác vụ này.'); const row=attempt.rows[0];
    if(row.section_key==='draft' && (resultStatus!=='passed' || !lmsUrl)) throw new ApiError(400,'DRAFT_LMS_RESULT_REQUIRED','Draft chỉ hoàn tất khi có link LMS hợp lệ.');
    await client.query(`UPDATE writing_practice.comment SET status='completed',content=$2 WHERE attempt_id=$1`,[row.id,storedFeedback]);
    if(resultStatus==='passed') await client.query(`UPDATE writing_practice.session_section SET locked=true,fail_streak=0,updated_at=now() WHERE session_id=$1 AND section_key=$2`,[row.session_id,row.section_key]);
    else await client.query(`UPDATE writing_practice.session_section SET fail_streak=fail_streak+1,updated_at=now() WHERE session_id=$1 AND section_key=$2`,[row.session_id,row.section_key]);
    const state=await client.query(`SELECT fail_streak FROM writing_practice.session_section WHERE session_id=$1 AND section_key=$2`,[row.session_id,row.section_key]); return {attemptRef:jobRef,status:'completed',resultStatus,version:row.version,supportWarning:resultStatus==='needs_revision' && state.rows[0].fail_streak%3===0};
  }); }
  async function failJob({ jobRef,leaseToken,errorCode,retryable }) { return withTransaction(pool, async client => { const r=await client.query(`UPDATE writing_practice.check_attempt SET status=CASE WHEN $3 AND retry_count<3 THEN 'queued' ELSE 'failed' END,error_code=$4,lease_token=NULL,lease_expires_at=NULL,version=version+1,updated_at=now() WHERE public_id=$1 AND lease_token=$2 AND status='leased' AND lease_expires_at>now() RETURNING id,public_id,status,retry_count,version`,[jobRef,leaseToken,retryable,errorCode]); if(!r.rowCount) throw new ApiError(409,'LEASE_NOT_OWNED','Công việc không còn thuộc tác vụ này.'); if(r.rows[0].status==='failed') await client.query(`UPDATE writing_practice.comment SET status='technical_error',content=$2 WHERE attempt_id=$1`,[r.rows[0].id,r.rows[0].retry_count<3?'Tạm thời chưa thể chấm. Hãy nhấn Thử lại.':'Hệ thống chưa thể chấm sau ba lần thử. Vui lòng báo giảng viên.']); return {attemptRef:r.rows[0].public_id,...r.rows[0],canRetry:r.rows[0].status==='failed'&&r.rows[0].retry_count<3}; }); }
  async function recoverJobs() { return withTransaction(pool, async client => { const r=await client.query(`UPDATE writing_practice.check_attempt SET status=CASE WHEN retry_count<3 THEN 'queued' ELSE 'failed' END,lease_token=NULL,lease_expires_at=NULL,version=version+1,updated_at=now() WHERE status='leased' AND lease_expires_at<=now() RETURNING id,public_id,status,retry_count`); await client.query(`UPDATE writing_practice.comment comment SET status='technical_error',content=CASE WHEN attempt.retry_count<3 THEN 'Tạm thời chưa thể chấm. Hãy nhấn Thử lại.' ELSE 'Hệ thống chưa thể chấm sau ba lần thử. Vui lòng báo giảng viên.' END FROM writing_practice.check_attempt attempt WHERE comment.attempt_id=attempt.id AND attempt.status='failed' AND comment.status='queued'`); return r.rows.map(x=>({attemptRef:x.public_id,status:x.status,canRetry:x.status==='failed'&&x.retry_count<3})); }); }
  async function retryAttempt(attemptRef) { return withTransaction(pool, async client => { const r=await client.query(`UPDATE writing_practice.check_attempt attempt SET status='queued',error_code=NULL,version=version+1,updated_at=now() FROM writing_practice.session_section state WHERE attempt.public_id=$1 AND attempt.status='failed' AND attempt.retry_count<3 AND state.session_id=attempt.session_id AND state.section_key=attempt.section_key AND state.locked=false AND NOT EXISTS(SELECT 1 FROM writing_practice.check_attempt active WHERE active.session_id=attempt.session_id AND active.section_key=attempt.section_key AND active.status IN ('queued','leased')) RETURNING attempt.id,attempt.public_id,attempt.section_key,attempt.comment_number,attempt.version`,[attemptRef]); if(!r.rowCount) throw new ApiError(409,'ATTEMPT_NOT_RETRYABLE','Lượt này không thể thử lại.'); await client.query(`UPDATE writing_practice.comment SET status='queued',content='Đang chấm' WHERE attempt_id=$1`,[r.rows[0].id]); return {attemptRef:r.rows[0].public_id,section:r.rows[0].section_key,commentNumber:r.rows[0].comment_number,status:'queued',version:r.rows[0].version}; }); }
  async function reopenSection({sessionRef,section,actorRef,reason}) { return withTransaction(pool, async client => { const session=await client.query(`SELECT id FROM writing_practice.activity_session WHERE public_id=$1 FOR UPDATE`,[sessionRef]); if(!session.rowCount) throw new ApiError(404,'SESSION_NOT_FOUND','Không tìm thấy phiên làm bài.'); const state=await client.query(`UPDATE writing_practice.session_section SET locked=false,fail_streak=0,round_number=round_number+1,updated_at=now() WHERE session_id=$1 AND section_key=$2 AND locked=true RETURNING round_number`,[session.rows[0].id,section]); if(!state.rowCount) throw new ApiError(409,'SECTION_NOT_LOCKED','Phần này hiện không bị khóa.'); await client.query(`INSERT INTO writing_practice.admin_audit_event(session_id,section_key,action,actor_ref,reason) VALUES($1,$2,'reopen_section',$3,$4)`,[session.rows[0].id,section,actorRef,reason]); return sessionDetails(sessionRef,client); }); }
  return {getRoster,openSession,sessionDetails,saveDraft,submitCheck,publishLive,getAttempt,claimJobs,completeJob,failJob,recoverJobs,retryAttempt,reopenSection};
}
