/**
 * Nhận identity từ tuyến nội bộ, lưu hồ sơ và lượt chấm trong schema riêng.
 * Khóa theo Docs, callback phải đúng lease; không truy vấn bảng Writing/mapping.
 * Trả trạng thái thật và mã lỗi có thể phục hồi; không báo xong khi chưa readback.
 */
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export class ReadingListening67Error extends Error {
  constructor(code, status = 409) { super(code); this.code = code; this.status = status; }
}
const fail = (code, status) => { throw new ReadingListening67Error(code, status); };
const active = ['queued', 'validating', 'grading', 'writing'];
const terminal = ['done', 'incomplete', 'failed', 'needs_review'];
export function enoughCompletion(done, total) {
  if (!Number.isSafeInteger(done) || !Number.isSafeInteger(total) || total <= 0 || done < 0 || done > total) fail('COMPLETION_INVALID', 400);
  return BigInt(done) * 5n >= BigInt(total) * 4n;
}
export function createReadingListening67Store({ pool }) {
  async function transaction(work) {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const value = await work(c); await c.query('COMMIT'); return value; }
    catch (error) { await c.query('ROLLBACK'); throw error; }
    finally { c.release(); }
  }
  async function event(c, jobId, type, details = {}) {
    await c.query('INSERT INTO reading_listening67.job_event(event_id,job_id,event_type,details) VALUES($1,$2,$3,$4)', [randomUUID(), jobId, type, JSON.stringify(details)]);
  }
  async function ensureUnit(c, { documentId, tabId = '', assignmentCode }) {
    const unit = (await c.query(`INSERT INTO reading_listening67.document_unit(unit_id,document_id,tab_id,assignment_code)
      VALUES($1,$2,$3,$4) ON CONFLICT(document_id,tab_id,assignment_code) DO UPDATE SET updated_at=now() RETURNING *`,
    [randomUUID(), documentId, tabId, assignmentCode])).rows[0];
    const sources=(await c.query('SELECT * FROM reading_listening67.source_document WHERE document_id=$1',[documentId])).rows;
    for(const s of sources)await bind(c,unit,{courseId:s.course_id,courseworkId:s.coursework_id,submissionId:s.submission_id,studentId:s.student_id,classCode:s.class_code,sourceEventId:s.source_event_id});
    return {...unit,source_kind:sources.length?'classroom':unit.source_kind};
  }
  async function bind(c,unit,b) {
    await c.query(`INSERT INTO reading_listening67.classroom_binding(binding_id,unit_id,course_id,coursework_id,submission_id,student_id,class_code,source_event_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(unit_id,course_id,coursework_id,submission_id) DO NOTHING`,
    [randomUUID(),unit.unit_id,b.courseId,b.courseworkId,b.submissionId,b.studentId||null,b.classCode||null,b.sourceEventId]);
    await c.query("UPDATE reading_listening67.document_unit SET source_kind='classroom',updated_at=now() WHERE unit_id=$1",[unit.unit_id]);
  }
  async function owned(c, { jobId, leaseToken }) {
    const row = (await c.query('SELECT * FROM reading_listening67.job WHERE job_id=$1 FOR UPDATE', [jobId])).rows[0];
    if (!row) fail('JOB_NOT_FOUND', 404);
    if (row.lease_token !== leaseToken || !active.includes(row.status) || !row.lease_expires_at || new Date(row.lease_expires_at).getTime() <= Date.now()) fail('LEASE_NOT_OWNED');
    return row;
  }
  const api = {
    async ready() { await pool.query('SELECT 1 FROM reading_listening67.job LIMIT 0'); return true; },
    async courses() {
      return {courses:(await pool.query('SELECT course_id,class_code,classroom_name FROM reading_listening67.course_registry WHERE enabled=true ORDER BY course_id')).rows
        .map(x=>({courseId:x.course_id,classCode:x.class_code,classroomName:x.classroom_name}))};
    },
    async source({documentId,classroom}) {
      return transaction(async c=>{
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['rl67:'+documentId]);
        const b=classroom;
        if(b.classCode)await c.query(`INSERT INTO reading_listening67.course_registry(course_id,class_code,classroom_name,source_ref)
          VALUES($1,$2,$3,'google-classroom') ON CONFLICT(course_id) DO UPDATE SET class_code=excluded.class_code,classroom_name=excluded.classroom_name,updated_at=now()`,[b.courseId,b.classCode,b.classroomName||b.classCode]);
        const saved=(await c.query(`INSERT INTO reading_listening67.source_document(source_id,document_id,course_id,coursework_id,submission_id,student_id,class_code,homework_title,source_event_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(document_id,course_id,coursework_id,submission_id)
          DO UPDATE SET student_id=excluded.student_id,class_code=excluded.class_code,homework_title=excluded.homework_title,source_event_id=excluded.source_event_id,updated_at=now() RETURNING source_id,cta_state,cta_enqueued_at`,
        [randomUUID(),documentId,b.courseId,b.courseworkId,b.submissionId,b.studentId||null,b.classCode||null,b.homeworkTitle||null,b.sourceEventId])).rows[0];
        const units=(await c.query('SELECT * FROM reading_listening67.document_unit WHERE document_id=$1',[documentId])).rows;
        for(const unit of units)await bind(c,unit,b);
        const ctaNeeded=['pending','error'].includes(saved.cta_state)&&!saved.cta_enqueued_at;
        const dispatchToken=ctaNeeded?randomUUID():null;
        if(ctaNeeded)await c.query("UPDATE reading_listening67.source_document SET cta_state='pending',cta_error_code=NULL,cta_dispatch_token=$2 WHERE source_id=$1",[saved.source_id,dispatchToken]);
        return {saved:true,documentId,courseId:b.courseId,courseworkId:b.courseworkId,submissionId:b.submissionId,linkedUnits:units.length,ctaNeeded,...(dispatchToken?{dispatchToken}:{})};
      });
    },
    async sourceBatch({sources}) {
      const results=[];
      // Từng dòng idempotent; nếu một dòng lỗi, retry cả nhóm không tạo nguồn trùng.
      for(const source of sources)results.push(await api.source(source));
      return {sources:results};
    },
    async sourceCtaResult({documentId,state,errorCode}) {
      const rows=(await pool.query('UPDATE reading_listening67.source_document SET cta_state=$2,cta_error_code=$3,cta_enqueued_at=NULL,updated_at=now() WHERE document_id=$1 RETURNING source_id',[documentId,state,errorCode||null])).rows;
      return {saved:true,documentId,changed:rows.length};
    },
    async sourceCtaState({documentId}) {
      const rows=(await pool.query('SELECT cta_state FROM reading_listening67.source_document WHERE document_id=$1',[documentId])).rows;
      // Event cũ đã xử lý xong chỉ ACK; không đọc Google Docs lần nữa.
      return {documentId,shouldProcess:!rows.length||rows.some(x=>['pending','error'].includes(x.cta_state))};
    },
    async sourceCtaEnqueuedBatch({sources}) {
      return transaction(async c=>{
        const results=[];
        for(const s of sources){
          const row=(await c.query(`SELECT source_id,cta_state,cta_dispatch_token FROM reading_listening67.source_document
            WHERE document_id=$1 AND course_id=$2 AND coursework_id=$3 AND submission_id=$4 FOR UPDATE`,[s.documentId,s.courseId,s.courseworkId,s.submissionId])).rows[0];
          if(!row||row.cta_dispatch_token!==s.dispatchToken)fail('SOURCE_DISPATCH_IDENTITY_MISMATCH');
          // Chỉ đánh dấu SAU RabbitMQ nhận gửi. Callback kết thúc/lỗi đến trước ACK không bị ghi đè.
          if(row.cta_state==='pending')await c.query('UPDATE reading_listening67.source_document SET cta_enqueued_at=COALESCE(cta_enqueued_at,now()),updated_at=now() WHERE source_id=$1',[row.source_id]);
          results.push({...s,saved:true,marked:row.cta_state==='pending',state:row.cta_state});
        }
        return {sources:results};
      });
    },
    async scanStart({executionId}) {
      return transaction(async c=>{
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))',['rl67:source-scan']);
        await c.query("UPDATE reading_listening67.source_scan_run SET status='failed',finished_at=now() WHERE status='running' AND lease_expires_at<now()");
        if((await c.query("SELECT execution_id FROM reading_listening67.source_scan_run WHERE status='running'")).rows.length)return {acquired:false};
        const token=randomUUID();
        await c.query("INSERT INTO reading_listening67.source_scan_run(execution_id,lease_token,status,lease_expires_at) VALUES($1,$2,'running',now()+interval '40 minutes')",[executionId,token]);
        return {acquired:true,executionId,leaseToken:token};
      });
    },
    async scanCourseResult({executionId,leaseToken,courseId,status,errorCode}) {
      return transaction(async c=>{
        const owner=(await c.query("SELECT execution_id FROM reading_listening67.source_scan_run WHERE execution_id=$1 AND lease_token=$2 AND status='running' AND lease_expires_at>now() FOR UPDATE",[executionId,leaseToken])).rows[0];
        if(!owner)fail('SCAN_LEASE_NOT_OWNED');
        await c.query(`INSERT INTO reading_listening67.source_scan_course(execution_id,course_id,status,error_code) VALUES($1,$2,$3,$4)
          ON CONFLICT(execution_id,course_id) DO UPDATE SET status=excluded.status,error_code=excluded.error_code,updated_at=now()`,[executionId,courseId,status,errorCode||null]);
        return {saved:true,courseId,status};
      });
    },
    async scanFinish({executionId,leaseToken}) {
      return transaction(async c=>{
        const owner=(await c.query("SELECT status FROM reading_listening67.source_scan_run WHERE execution_id=$1 AND lease_token=$2 AND status='running' AND lease_expires_at>now() FOR UPDATE",[executionId,leaseToken])).rows[0];
        if(!owner)fail('SCAN_LEASE_NOT_OWNED');
        const counts=(await c.query("SELECT count(*)::int AS total,count(*) FILTER(WHERE status='failed')::int AS failed FROM reading_listening67.source_scan_course WHERE execution_id=$1",[executionId])).rows[0];
        const status=counts.failed?'partial':'done';
        await c.query('UPDATE reading_listening67.source_scan_run SET status=$2,finished_at=now() WHERE execution_id=$1',[executionId,status]);
        return {status,courses:counts.total,failed:counts.failed};
      });
    },
    async catalog({ assignmentCode }) {
      const row = (await pool.query(`SELECT assignment_code,workflow_id,template_version,grader_version,source_sha256
        FROM reading_listening67.assignment_catalog WHERE assignment_code=$1 AND enabled=true`, [assignmentCode])).rows[0];
      if (!row) fail('ASSIGNMENT_UNAVAILABLE', 503);
      return { assignmentCode: row.assignment_code, workflowId: row.workflow_id,
        templateVersion: row.template_version, graderVersion: row.grader_version, sourceSha256: row.source_sha256 };
    },
    async register(input) {
      return transaction(async c => {
        const unit = await ensureUnit(c, input);
        if (input.classroom) {
          await bind(c,unit,input.classroom);
        }
        return { unitId: unit.unit_id, documentId:unit.document_id,assignmentCode:unit.assignment_code,tabId:unit.tab_id, sourceKind: input.classroom ? 'classroom' : unit.source_kind };
      });
    },
    async accept(input) {
      return transaction(async c => {
        // Cùng mã lượt bấm nhưng khác Docs vẫn phải nối tiếp bước kiểm identity.
        // Khóa request trước Docs thống nhất thứ tự, tránh đụng UNIQUE thành lỗi DB chung.
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['rl67:request:' + input.requestId]);
        // Khóa giao dịch cùng Docs: ngăn hai request cùng vượt bước tìm lượt đang chạy.
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['rl67:' + input.documentId]);
        const existingRequest = (await c.query('SELECT * FROM reading_listening67.job WHERE request_id=$1', [input.requestId])).rows[0];
        if (existingRequest) {
          const unit = (await c.query('SELECT tab_id FROM reading_listening67.document_unit WHERE unit_id=$1', [existingRequest.unit_id])).rows[0];
          if (existingRequest.document_id !== input.documentId || existingRequest.assignment_code !== input.assignmentCode || unit.tab_id !== (input.tabId || '')) fail('REQUEST_IDENTITY_MISMATCH');
          return { jobId: existingRequest.job_id, status: existingRequest.status, replayed: true };
        }
        const busy = (await c.query('SELECT * FROM reading_listening67.job WHERE document_id=$1 AND status=ANY($2::text[])', [input.documentId, [...active, 'needs_review']])).rows[0];
        if (busy) {
          const unit = (await c.query('SELECT tab_id FROM reading_listening67.document_unit WHERE unit_id=$1', [busy.unit_id])).rows[0];
          if (busy.assignment_code !== input.assignmentCode || unit.tab_id !== (input.tabId || '')) fail('DOCUMENT_BUSY');
          return { jobId: busy.job_id, status: busy.status, replayed: true };
        }
        const unit = await ensureUnit(c, input);
        const jobId = input.jobId || randomUUID();
        await c.query('INSERT INTO reading_listening67.job(job_id,request_id,unit_id,document_id,assignment_code) VALUES($1,$2,$3,$4,$5)', [jobId, input.requestId, unit.unit_id, input.documentId, input.assignmentCode]);
        await event(c, jobId, 'accepted');
        return { jobId, status: 'queued', replayed: false };
      });
    },
    async claim({ jobId, executionId }) {
      return transaction(async c => {
        // Chỉ hai lượt RL67 được chạy cùng lúc trên n8n/AI dùng chung.
        // Chờ năng lực không tính thành lỗi gọi n8n và không mất lượt đã nhận.
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['rl67:capacity']);
        const candidate = (await c.query('SELECT status FROM reading_listening67.job WHERE job_id=$1 FOR UPDATE', [jobId])).rows[0];
        if (!candidate || candidate.status !== 'queued') fail('JOB_NOT_CLAIMABLE');
        const running = (await c.query("SELECT count(*)::int AS n FROM reading_listening67.job WHERE status IN ('validating','grading','writing')")).rows[0].n;
        if (running >= 2) {
          await c.query(`UPDATE reading_listening67.job SET dispatch_after=now()+interval '15 seconds',
            dispatch_attempts=GREATEST(dispatch_attempts-1,0),updated_at=now() WHERE job_id=$1`, [jobId]);
          return { jobId, status: 'queued', deferred: true };
        }
        const token = randomUUID();
        const row = (await c.query(`UPDATE reading_listening67.job SET status='validating',lease_token=$2,
          lease_expires_at=now()+interval '20 minutes',attempt_no=attempt_no+1,execution_id=$3,updated_at=now()
          WHERE job_id=$1 AND status='queued' RETURNING *`, [jobId, token, executionId])).rows[0];
        if (!row) fail('JOB_NOT_CLAIMABLE');
        const unit = (await c.query('SELECT tab_id FROM reading_listening67.document_unit WHERE unit_id=$1', [row.unit_id])).rows[0];
        await event(c, jobId, 'claimed', { attempt: row.attempt_no });
        return { jobId, documentId: row.document_id, assignmentCode: row.assignment_code, tabId: unit.tab_id || null, leaseToken: token, leaseExpiresAt: row.lease_expires_at };
      });
    },
    async validate(input) {
      return transaction(async c => {
        const row = await owned(c, input);
        if (row.status !== 'validating') fail('JOB_NOT_VALIDATING');
        if (row.document_id !== input.documentId || row.assignment_code !== input.assignmentCode) fail('VALIDATION_IDENTITY_MISMATCH');
        const unit = (await c.query('SELECT tab_id FROM reading_listening67.document_unit WHERE unit_id=$1', [row.unit_id])).rows[0];
        if (unit.tab_id !== (input.tabId || '')) fail('VALIDATION_IDENTITY_MISMATCH');
        const enough = enoughCompletion(input.done, input.total);
        await c.query(`UPDATE reading_listening67.job SET status=$2,source_revision=$3,template_version=$4,grader_version=$5,
          answer_sha256=$6,completion_done=$7,completion_total=$8,updated_at=now() WHERE job_id=$1`,
        [input.jobId, enough ? 'grading' : 'writing', input.sourceRevision, input.templateVersion, input.graderVersion, input.answerSha256, input.done, input.total]);
        await event(c, input.jobId, 'validated', { done: input.done, total: input.total, enough });
        return { enough, status: enough ? 'grading' : 'writing' };
      });
    },
    async renew(input) {
      return transaction(async c => {
        const row=await owned(c, input);
        if(input.phase==='writing'){
          if(!['grading','writing'].includes(row.status))fail('WRITING_VALIDATION_REQUIRED');
          await c.query("UPDATE reading_listening67.job SET status='writing' WHERE job_id=$1",[input.jobId]);
        }
        await c.query("UPDATE reading_listening67.job SET lease_expires_at=now()+interval '20 minutes',updated_at=now() WHERE job_id=$1", [input.jobId]);
        return { renewed: true };
      });
    },
    async finish(input) {
      return transaction(async c => {
        const row = (await c.query('SELECT * FROM reading_listening67.job WHERE job_id=$1 FOR UPDATE', [input.jobId])).rows[0];
        if (!row) fail('JOB_NOT_FOUND', 404);
        if (terminal.includes(row.status)) {
          // Retry callback được nhận chỉ khi cả lease lẫn thành quả trùng bản đã lưu.
          if (row.lease_token !== input.leaseToken || row.status !== input.status || row.warning_state !== (input.warningState || 'unchecked') || row.error_code !== (input.errorCode || null) || !isDeepStrictEqual(row.result, input.result || {})) fail('RESULT_REPLAY_MISMATCH');
          return { status: row.status, replayed: true };
        }
        await owned(c, input);
        if (!terminal.includes(input.status)) fail('RESULT_STATUS_INVALID', 400);
        if (['done', 'incomplete'].includes(input.status)) {
          if (!row.source_revision || row.completion_total == null) fail('VALIDATION_REQUIRED');
          const enough = enoughCompletion(row.completion_done, row.completion_total);
          if (input.status === 'done' && (!enough || input.warningState !== 'absent_verified')) fail('DONE_PROOF_INVALID');
          if (input.status === 'incomplete' && enough) fail('INCOMPLETE_PROOF_INVALID');
          const p = input.proof;
          if (!p || p.documentId !== row.document_id || p.assignmentCode !== row.assignment_code || p.jobId !== row.job_id || p.verified !== true || !p.revisionId) fail('READBACK_PROOF_REQUIRED');
          if (input.status === 'incomplete' && !['present_verified', 'write_failed'].includes(input.warningState)) fail('WARNING_PROOF_INVALID');
        }
        await c.query(`UPDATE reading_listening67.job SET status=$2,result=$3,warning_state=$4,error_code=$5,
          lease_expires_at=NULL,updated_at=now() WHERE job_id=$1`, [input.jobId, input.status, JSON.stringify(input.result || {}), input.warningState || 'unchecked', input.errorCode || null]);
        await event(c, input.jobId, 'finished', { status: input.status, warningState: input.warningState || 'unchecked' });
        return { status: input.status, replayed: false };
      });
    },
    async status({ jobId }) {
      const row = (await pool.query('SELECT job_id,status,completion_done,completion_total,warning_state,error_code,updated_at,result FROM reading_listening67.job WHERE job_id=$1', [jobId])).rows[0];
      if (!row) fail('JOB_NOT_FOUND', 404);
      // Chỉ đưa số lượng kết quả ra trang chấm; không đưa bài làm hoặc định danh lớp.
      const summary = Object.fromEntries(['total','correct','partial','incorrect','missing']
        .filter(k => Number.isSafeInteger(row.result?.summary?.[k]) && row.result.summary[k] >= 0)
        .map(k => [k, row.result.summary[k]]));
      return { jobId: row.job_id, status: row.status, completion: row.completion_total == null ? null : { done: row.completion_done, total: row.completion_total }, warningState: row.warning_state, errorCode: row.error_code, updatedAt: row.updated_at,
        ...(Object.keys(summary).length ? { summary } : {}) };
    },
    async executionFailed({ executionId, errorCode }) {
      return transaction(async c => {
        // Chỉ nhận execution đã claim. Sau validate có thể đã ghi, cần kiểm Docs.
        const rows = (await c.query(`UPDATE reading_listening67.job SET
          status=CASE WHEN status='validating' THEN 'failed' ELSE 'needs_review' END,
          error_code=$2,updated_at=now() WHERE execution_id=$1
          AND status IN ('validating','grading','writing') RETURNING job_id,status`, [executionId, errorCode])).rows;
        for (const row of rows) await event(c, row.job_id, 'execution_failed', { status: row.status, errorCode });
        return { changed: rows.length };
      });
    },
    async resolveReview({ jobId, processorExecutionId, proof }) {
      return transaction(async c => {
        const row = (await c.query('SELECT * FROM reading_listening67.job WHERE job_id=$1 FOR UPDATE', [jobId])).rows[0];
        if (!row) fail('JOB_NOT_FOUND', 404);
        if (row.execution_id !== processorExecutionId || proof.documentId !== row.document_id || proof.assignmentCode !== row.assignment_code) fail('REVIEW_IDENTITY_MISMATCH');
        // Chỉ mở lại ca đã chứng minh dừng trước request ghi cảnh báo/chấm chuyên môn.
        // Các ca ghi không rõ kết quả vẫn giữ needs_review; không reset hàng loạt.
        if (row.status === 'failed' && row.error_code === 'RL67_SOURCE_CHANGED_RETRY' && isDeepStrictEqual(row.result?.review, proof)) return { status: 'failed', reviewed: true, replayed: true };
        if (row.status !== 'needs_review' || proof.verified !== true || proof.processorStopped !== true || proof.warningStopped !== true
          || proof.noWarningWriteAttempted !== true || proof.noGradingInvoked !== true || !['RL67_WARNING_SOURCE_CHANGED','WARNING_ANCHOR_AMBIGUOUS'].includes(proof.sourceError) || !proof.revisionId || !proof.warningExecutionId) fail('REVIEW_PROOF_INVALID');
        await c.query(`UPDATE reading_listening67.job SET status='failed',error_code='RL67_SOURCE_CHANGED_RETRY',
          result=$2,lease_expires_at=NULL,updated_at=now() WHERE job_id=$1`, [jobId, JSON.stringify({ review: proof })]);
        await event(c, jobId, 'reviewed_before_write', { processorExecutionId, warningExecutionId: proof.warningExecutionId, revisionId: proof.revisionId });
        return { status: 'failed', reviewed: true, replayed: false };
      });
    },
    async recoverExpired() {
      return transaction(async c => {
        // Không tự chấm lại khi có khả năng đã ghi Docs: đưa vào kiểm tra bằng chứng.
        const rows = (await c.query(`UPDATE reading_listening67.job SET status='needs_review',error_code='LEASE_EXPIRED_CHECK_DOCS',updated_at=now()
          WHERE status IN ('validating','grading','writing') AND lease_expires_at<now() RETURNING job_id`)).rows;
        for (const row of rows) await event(c, row.job_id, 'lease_expired');
        // n8n có thể nhận HTTP nhưng chết trước claim: không để queued vô hạn.
        const undispatched = (await c.query(`UPDATE reading_listening67.job SET status='failed',
          error_code='DISPATCH_NOT_CLAIMED',updated_at=now() WHERE status='queued' AND dispatch_attempts>=6
          AND dispatch_after<=now() RETURNING job_id`)).rows;
        for (const row of undispatched) await event(c, row.job_id, 'dispatch_not_claimed');
        return { needsReview: rows.length, dispatchFailed: undispatched.length };
      });
    },
    async dispatchDue() {
      return transaction(async c => {
        await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['rl67:capacity']);
        const running = (await c.query("SELECT count(*)::int AS n FROM reading_listening67.job WHERE status IN ('validating','grading','writing')")).rows[0].n;
        if (running >= 2) return null;
        const row = (await c.query(`SELECT job_id FROM reading_listening67.job WHERE status='queued'
          AND dispatch_after<=now() AND dispatch_attempts<6 ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`)).rows[0];
        if (!row) return null;
        const token = randomUUID();
        await c.query(`UPDATE reading_listening67.job SET dispatch_token=$2,dispatch_attempts=dispatch_attempts+1,
          dispatch_after=now()+interval '30 seconds',updated_at=now() WHERE job_id=$1`, [row.job_id, token]);
        return { jobId: row.job_id, dispatchToken: token };
      });
    },
    async dispatchFailed({ jobId, dispatchToken }) {
      return transaction(async c => {
        const row = (await c.query(`UPDATE reading_listening67.job SET error_code='DISPATCH_FAILED',
          status=CASE WHEN dispatch_attempts>=6 THEN 'failed' ELSE status END,updated_at=now()
          WHERE job_id=$1 AND dispatch_token=$2 AND status='queued' RETURNING status`, [jobId, dispatchToken])).rows[0];
        if (row) await event(c, jobId, 'dispatch_failed');
        return { changed: !!row };
      });
    },
  };
  return api;
}
