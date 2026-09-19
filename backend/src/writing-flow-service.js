import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { createWritingFlowIntake } from './writing-flow-intake.js';
import { createWritingFlowOperations, STAGES } from './writing-flow-operations.js';

// Nguồn vào: bản sao phân công lớp đã có sẵn trong PostgreSQL.
// Việc chính: chuẩn hóa tên lớp thành mã lớp và gom các giảng viên đang hoạt động.
// Kết quả: dashboard lọc được theo giảng viên mà không ghi hoặc sửa dữ liệu Lark Base.
// Khi thiếu phân công: trả mảng rỗng để bài vẫn hiện theo lớp và trạng thái.
const teacherAssignmentsCte = `teacher_assignments AS (
  SELECT class_code,array_agg(DISTINCT teacher_name ORDER BY teacher_name) AS teacher_names
    FROM (
      SELECT CASE
        WHEN upper(payload->>'Tên lớp') ~ 'IC[[:space:].]*[0-9]{4,6}'
          THEN 'IC' || regexp_replace(substring(upper(payload->>'Tên lớp')
            from 'IC[[:space:].]*[0-9]{4,6}'),'[^0-9]','','g')
        WHEN upper(payload->>'Tên lớp') ~ 'CS[[:space:].]*[0-9]{6}'
          THEN 'CS.' || regexp_replace(substring(upper(payload->>'Tên lớp')
            from 'CS[[:space:].]*[0-9]{6}'),'[^0-9]','','g')
      END AS class_code,
      nullif(trim(payload->>'Tên hiển thị'),'') AS teacher_name
      FROM mapping.lark_export_teacher_assignments
      WHERE payload->>'Trạng thái tài khoản'='active'
    ) AS normalized
   WHERE class_code IS NOT NULL AND teacher_name IS NOT NULL
   GROUP BY class_code
)`;
const emptyTeacherAssignmentsCte = `teacher_assignments AS (
  SELECT NULL::text AS class_code,ARRAY[]::text[] AS teacher_names WHERE false
)`;

// Nhận vào: tên lớp từ nguồn mapping hoặc mã lớp trong bảng homework.
// Việc chính: nhận cả IC2269 và dạng CS.070626, rồi đưa về một cách viết ổn định.
// Trả ra: mã lớp để đối chiếu; chuỗi rỗng nếu tên không có mã lớp nhận biết được.
// Khi tên khác quy tắc: dashboard hiện “Không đọc được mã lớp” để người vận hành kiểm tra.
export function classCodeFromName(value) {
  const match = String(value || '').toUpperCase()
    .match(/\b(IC\s*\.?\s*\d{4,6}|CS\s*\.?\s*\d{6})\b/u);
  if (!match) return '';
  const compact = match[1].replace(/\s+/gu, '');
  if (compact.startsWith('IC')) return `IC${compact.replace(/\D/gu, '')}`;
  return `CS.${compact.replace(/\D/gu, '')}`;
}

// Nhận vào: lớp đang vận hành từ mapping và mã lớp thấy trong lượt quét Writing gần nhất.
// Việc chính: ghép theo mã lớp, giữ cả lớp thiếu trong nguồn và lớp lạ có trong nguồn.
// Trả ra: các trạng thái ngắn để dashboard giải thích được việc đồng bộ lớp.
// Khi thiếu mã: giữ riêng dòng đó, không tự đoán hoặc coi là đã được quét.
export function mergeClassCoverage(expectedRows = [], seenRows = []) {
  const rows = new Map();
  const missingCode = [];
  for (const source of expectedRows) {
    const classCode = classCodeFromName(source.class_name);
    if (!classCode) {
      missingCode.push({ class_code: null, class_name: source.class_name || 'Chưa rõ tên lớp',
        status: 'class_code_missing', expected: true, seen: false,
        source_updated_at: source.source_updated_at || null, last_scanned_at: null });
      continue;
    }
    const current = rows.get(classCode) || { class_code: classCode, class_name: source.class_name,
      expected: true, seen: false, erp_source_found: true, classroom_source_found: true,
      source_updated_at: source.source_updated_at || null, last_scanned_at: null };
    current.expected = true;
    current.class_name ||= source.class_name;
    current.erp_source_found = current.erp_source_found && source.erp_source_found !== false;
    current.classroom_source_found = current.classroom_source_found
      && source.classroom_source_found !== false;
    rows.set(classCode, current);
  }
  for (const source of seenRows) {
    const classCode = classCodeFromName(source.class_code);
    if (!classCode) continue;
    const current = rows.get(classCode) || { class_code: classCode, class_name: classCode,
      expected: false, seen: false, erp_source_found: null, classroom_source_found: null,
      source_updated_at: null, last_scanned_at: null };
    current.seen = true;
    current.last_scanned_at = source.last_scanned_at || null;
    rows.set(classCode, current);
  }
  const priority = { missing_source: 0, mapping_issue: 1, class_code_missing: 2,
    unexpected_source: 3, excluded: 4, covered: 5 };
  const covered = [...rows.values()].map(row => ({ ...row,
    status: row.class_code === 'IC2288' ? 'excluded'
      : row.expected && (!row.erp_source_found || !row.classroom_source_found) ? 'mapping_issue'
        : row.expected && !row.seen ? 'missing_source'
          : !row.expected && row.seen ? 'unexpected_source' : 'covered' }));
  return [...covered, ...missingCode].sort((a, b) =>
    (priority[a.status] - priority[b.status])
      || String(a.class_code || a.class_name).localeCompare(String(b.class_code || b.class_name), 'vi'));
}

// Nhận vào: pool PostgreSQL và yêu cầu của quản trị viên đã xác thực.
// Việc chính: chỉ đọc trạng thái từng cặp hoặc ghi yêu cầu chạy lại vào hàng bàn giao bền.
// Trả ra: trạng thái, mã cặp và bước; không đọc bài làm hay kết quả đã mã hóa.
// Khi lỗi: transaction hoàn tác; màn hình nhận mã lỗi và giữ mục Cần kiểm tra.
export function createWritingFlowService({ pool, encryptionKey = null }) {
  const operations = createWritingFlowOperations({ pool, encryptionKey });
  let teacherAssignmentsSource;
  async function teacherAssignmentsForDatabase() {
    if (!teacherAssignmentsSource) {
      teacherAssignmentsSource = pool.query(`SELECT coalesce(has_table_privilege(
          current_user,to_regclass('mapping.lark_export_teacher_assignments'),'SELECT'),false)
          AS can_read`)
        .then(result => result.rows[0]?.can_read
          ? teacherAssignmentsCte : emptyTeacherAssignmentsCte);
    }
    return teacherAssignmentsSource;
  }
  return {
    ...operations,
    intakePairs: createWritingFlowIntake({ pool, encryptionKey }),
    // Nhận vào: định danh execution lỗi từ Error Trigger của n8n.
    // Việc chính: giữ một dòng cho một execution, kể cả lỗi trước khi tạo mã bài.
    // Trả ra: biên nhận và số lần cùng lỗi được gửi; không lưu stack hoặc nội dung bài.
    // Khi API tạm mất: n8n vẫn giữ execution lỗi để đối chiếu sau.
    async recordWorkflowFailure({ workflowId, workflowName, executionId, lastNode, errorKind }) {
      const result = await pool.query(`INSERT INTO writing_flow.workflow_failure
        (workflow_id,workflow_name,execution_id,last_node,error_kind)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (workflow_id,execution_id) DO UPDATE
          SET workflow_name=EXCLUDED.workflow_name,
              last_node=EXCLUDED.last_node,error_kind=EXCLUDED.error_kind,
              seen_count=writing_flow.workflow_failure.seen_count+1,last_seen_at=now()
        RETURNING failure_id,workflow_id,execution_id,seen_count`,
      [workflowId, workflowName, executionId, lastNode, errorKind]);
      return result.rows[0];
    },

    async listWorkflowFailures({ limit = 100, offset = 0 } = {}) {
      const result = await pool.query(`SELECT failure_id,workflow_id,workflow_name,execution_id,
          last_node,error_kind,seen_count,first_seen_at,last_seen_at
        FROM writing_flow.workflow_failure
        ORDER BY last_seen_at DESC,failure_id
        LIMIT $1 OFFSET $2`, [limit, offset]);
      return result.rows;
    },
    async recordSourceIssue({ appId, tableId, recordId, docId = null, linkIndex = null,
      essaySlot = null, classCode = null, reasonCode }) {
      // Chỉ lưu định danh kỹ thuật và mã lỗi; không lưu link gốc hoặc bài học viên.
      const issueKey = crypto.createHash('sha256')
        .update(JSON.stringify([appId, tableId, recordId, docId ?? '', linkIndex ?? 0,
          essaySlot ?? 0, reasonCode]))
        .digest('hex');
      const result = await pool.query(`
        INSERT INTO writing_flow.source_issue
          (issue_key,source_app_id,source_table_id,source_record_id,
           homework_file_id,source_link_index,
           essay_slot,class_code,reason_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (issue_key) DO UPDATE
          SET status='open',resolved_at=NULL,
              occurrence_count=writing_flow.source_issue.occurrence_count+1,
              last_seen_at=now()
        RETURNING issue_key,status,reason_code,occurrence_count`,
      [issueKey, appId, tableId, recordId,
        docId, linkIndex, essaySlot, classCode, reasonCode]);
      return result.rows[0];
    },

    async listSourceIssues({ limit = 100, offset = 0 } = {}) {
      const result = await pool.query(`
        SELECT i.issue_key,i.source_app_id,i.source_table_id,i.source_record_id,
               i.homework_file_id,i.source_link_index,
               i.essay_slot,i.class_code,i.reason_code,i.occurrence_count,
               i.first_seen_at,i.last_seen_at,
               s.source_id,s.source_type,s.display_name,s.student_name,s.teacher_names,
               s.classroom_url,s.file_url,s.source_status
          FROM writing_flow.source_issue AS i
          LEFT JOIN writing_flow.source_record AS s
            ON s.source_app_id=i.source_app_id AND s.source_table_id=i.source_table_id
           AND s.source_record_id=i.source_record_id
           AND s.homework_file_id IS NOT DISTINCT FROM i.homework_file_id
           AND s.source_link_index IS NOT DISTINCT FROM i.source_link_index
         WHERE i.status='open'
         ORDER BY i.last_seen_at DESC,i.issue_key
         LIMIT $1 OFFSET $2`, [limit, offset]);
      return result.rows;
    },
    async summary() {
      const assignments = await teacherAssignmentsForDatabase();
      const result = await pool.query(`
        WITH ${assignments}
        SELECT p.class_code,p.status,count(*)::integer AS pair_count,
               coalesce(t.teacher_names,ARRAY[]::text[]) AS teacher_names
          FROM writing_flow.pair AS p
          LEFT JOIN teacher_assignments AS t USING (class_code)
         GROUP BY p.class_code,p.status,t.teacher_names
         ORDER BY p.class_code,p.status`);
      return result.rows;
    },

    async dashboardCounts({ classCode = null, teacherName = null } = {}) {
      const assignments = await teacherAssignmentsForDatabase();
      const result = await pool.query(`WITH ${assignments}, current_pair AS (
          SELECT p.pair_id,p.class_code,p.status,p.skipped_at,
            coalesce(nullif(s.teacher_names,ARRAY[]::text[]),t.teacher_names,ARRAY[]::text[]) AS teacher_names,
            coalesce(active.stage_key,CASE WHEN p.status='delivered' THEN 'deliver' ELSE 'intake' END) AS stage_key,
            coalesce(active.stage_status,CASE WHEN p.status='delivered' THEN 'succeeded' ELSE 'pending' END) AS stage_status
          FROM writing_flow.pair AS p
          LEFT JOIN teacher_assignments AS t USING (class_code)
          LEFT JOIN writing_flow.source_record AS s ON s.source_id=p.source_id
          LEFT JOIN LATERAL (
            SELECT sr.stage_key,sr.status AS stage_status
            FROM writing_flow.stage_result AS sr
            WHERE sr.pair_id=p.pair_id
              AND sr.status IN ('pending','running','needs_review')
            ORDER BY array_position($3::text[],sr.stage_key) LIMIT 1
          ) AS active ON true
          WHERE p.status<>'superseded'
            AND ($1::text IS NULL OR p.class_code=$1)
            AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(s.teacher_names,ARRAY[]::text[]),t.teacher_names,ARRAY[]::text[])))
        )
        SELECT stage_key,stage_status,(skipped_at IS NOT NULL) AS skipped,count(*)::integer AS pair_count
        FROM current_pair GROUP BY stage_key,stage_status,(skipped_at IS NOT NULL)
        ORDER BY array_position($3::text[],stage_key),stage_status`,
      [classCode, teacherName, STAGES]);
      const support = await pool.query(`SELECT
          (SELECT count(*)::integer FROM writing_flow.source_issue WHERE status='open') AS source_issues,
          (SELECT count(*)::integer FROM writing_flow.manual_review WHERE status<>'resolved') AS reviews,
          (SELECT count(*)::integer FROM writing_flow.workflow_failure
             WHERE last_seen_at>now()-interval '7 days') AS technical_errors`);
      return { stages: result.rows, support: support.rows[0] };
    },

    async listClassCoverage() {
      const [expected, seen] = await Promise.all([
        pool.query(`SELECT 'registry:' || class_code AS source_key,updated_at AS source_updated_at,
            coalesce(classroom_name,class_code) AS class_name,true AS erp_source_found,
            (enabled OR class_code='IC2288') AS classroom_source_found
          FROM writing_flow.class_registry ORDER BY class_code`),
        pool.query(`SELECT class_code,last_scan_at AS last_scanned_at
          FROM writing_flow.class_registry WHERE last_scan_at IS NOT NULL`),
      ]);
      return mergeClassCoverage(expected.rows, seen.rows);
    },

    async listPairs({ classCode = null, teacherName = null, stageKey = null,
      stageStatus = null, view = null, limit = 50, offset = 0,
      cursorAt = null, cursorId = null } = {}) {
      const assignments = await teacherAssignmentsForDatabase();
      const result = await pool.query(`
        WITH ${assignments}
        SELECT p.pair_id, p.class_code, p.source_app_id, p.source_table_id,
               p.source_record_id, p.homework_file_id,
               p.source_link_index, p.essay_slot, p.task_type, p.status,
               p.source_type,p.created_at,p.updated_at,p.finished_at,p.skipped_at,
               p.skipped_by,p.skip_reason,
               coalesce(s.display_name,'') AS display_name,
               coalesce(s.student_name,'') AS student_name,
               coalesce(nullif(s.teacher_names,ARRAY[]::text[]),t.teacher_names,ARRAY[]::text[]) AS teacher_names,
               s.classroom_url,s.file_url,s.source_status,s.source_created_at,
               coalesce(current_stage.stage_key,
                 CASE WHEN p.status='delivered' THEN 'deliver' ELSE 'intake' END) AS stage_key,
               coalesce(current_stage.stage_status,
                 CASE WHEN p.status='delivered' THEN 'succeeded' ELSE 'pending' END) AS stage_status,
               coalesce(current_stage.attempt_count,0) AS attempt_count
          FROM writing_flow.pair AS p
          LEFT JOIN teacher_assignments AS t USING (class_code)
          LEFT JOIN writing_flow.source_record AS s ON s.source_id=p.source_id
          LEFT JOIN LATERAL (
            SELECT s.stage_key, s.status AS stage_status, s.attempt_count
             FROM writing_flow.stage_result AS s
             WHERE s.pair_id = p.pair_id
               AND s.status IN ('pending','running','needs_review')
             ORDER BY array_position($3::text[],s.stage_key)
             LIMIT 1
          ) AS current_stage ON true
         WHERE ($1::text IS NULL OR p.class_code = $1)
           AND ($2::text IS NULL OR $2 = ANY(coalesce(nullif(s.teacher_names,ARRAY[]::text[]),t.teacher_names,ARRAY[]::text[])))
           AND p.status<>'superseded'
           AND ($4::text IS NULL OR coalesce(current_stage.stage_key,
                 CASE WHEN p.status='delivered' THEN 'deliver' ELSE 'intake' END)=$4)
           AND ($5::text IS NULL OR coalesce(current_stage.stage_status,
                 CASE WHEN p.status='delivered' THEN 'succeeded' ELSE 'pending' END)=$5)
           AND (($6::text='skipped' AND p.skipped_at IS NOT NULL)
             OR ($6::text='delivered' AND p.status='delivered' AND p.skipped_at IS NULL)
             OR ($6::text='unfinished' AND p.status<>'delivered' AND p.skipped_at IS NULL)
             OR ($6::text IS NULL AND p.skipped_at IS NULL))
           AND ($7::timestamptz IS NULL OR (p.updated_at,p.pair_id)<($7::timestamptz,$8::uuid))
         ORDER BY p.updated_at DESC, p.pair_id DESC
         LIMIT $9 OFFSET $10`, [classCode, teacherName, STAGES, stageKey, stageStatus, view,
        cursorAt, cursorId, limit, offset]);
      return result.rows;
    },

    // Nhận vào: mã của đúng một cặp đề–bài do quản trị viên chọn trên trang.
    // Việc chính: ghép các mốc giai đoạn, lần thử, AI, bàn giao và kiểm tra thành lịch sử theo giờ.
    // Trả ra: mã kỹ thuật, trạng thái và lỗi; không truy vấn bài viết, prompt hoặc kết quả đã mã hóa.
    // Khi không thấy bài: trả 404 để trang không nhầm lịch sử của một bài khác.
    async pairHistory({ pairId }) {
      const found = await pool.query(`SELECT p.pair_id,p.class_code,p.task_type,p.essay_slot,p.status,
          p.source_type,p.skipped_at,p.skipped_by,p.skip_reason,p.finished_at,
          s.display_name,s.student_name,s.teacher_names,s.classroom_url,s.file_url,s.source_status
        FROM writing_flow.pair AS p LEFT JOIN writing_flow.source_record AS s ON s.source_id=p.source_id
        WHERE p.pair_id=$1`, [pairId]);
      if (!found.rowCount) throw new ApiError(404, 'WRITING_PAIR_NOT_FOUND', 'Không tìm thấy bài này.');
      const [stages, attempts, aiCalls, handoffs, reviews, operatorEvents] = await Promise.all([
        pool.query(`SELECT stage_key,status,cycle_no,attempt_count,error_code,
            n8n_execution_id,started_at,completed_at,updated_at
          FROM writing_flow.stage_result WHERE pair_id=$1`, [pairId]),
        pool.query(`SELECT stage_key,cycle_no,attempt_no,status,error_code,
            n8n_execution_id,attempt_id,started_at,finished_at
          FROM writing_flow.stage_attempt WHERE pair_id=$1
          ORDER BY started_at,attempt_id LIMIT 100`, [pairId]),
        pool.query(`SELECT stage_key,batch_index,status,provider,route,error_code,
            call_id,gateway_operation_id,created_at,finished_at
          FROM writing_flow.ai_call WHERE pair_id=$1
          ORDER BY created_at,call_id LIMIT 500`, [pairId]),
        pool.query(`SELECT from_stage,to_stage,status,send_count,error_code,
            handoff_id,created_at,last_sent_at,acknowledged_at
          FROM writing_flow.handoff WHERE pair_id=$1
          ORDER BY created_at,handoff_id LIMIT 100`, [pairId]),
        pool.query(`SELECT stage_key,cycle_no,status,error_code,review_id,
            opened_at,retry_requested_at,retry_accepted_at,resolved_at
          FROM writing_flow.manual_review WHERE pair_id=$1
          ORDER BY opened_at,review_id LIMIT 100`, [pairId]),
        pool.query(`SELECT event_type,actor_ref,reason,before_state,after_state,created_at,event_id
          FROM writing_flow.operator_event WHERE pair_id=$1
          ORDER BY created_at,event_id LIMIT 200`, [pairId]),
      ]);
      const events = [
        ...stages.rows.map(row => ({ kind: 'stage', at: row.updated_at, ...row })),
        ...attempts.rows.map(row => ({ kind: 'attempt', at: row.finished_at || row.started_at, ...row })),
        ...aiCalls.rows.map(row => ({ kind: 'ai_call', at: row.finished_at || row.created_at, ...row })),
        ...handoffs.rows.map(row => ({ kind: 'handoff', at: row.acknowledged_at || row.last_sent_at || row.created_at, ...row })),
        ...reviews.rows.map(row => ({ kind: 'review', at: row.resolved_at || row.retry_accepted_at || row.retry_requested_at || row.opened_at, ...row })),
        ...operatorEvents.rows.map(row => ({ kind: 'operator', at: row.created_at, ...row })),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      return { pair: found.rows[0], events };
    },

    async listReviews({ limit = 100, offset = 0 } = {}) {
      const assignments = await teacherAssignmentsForDatabase();
      const result = await pool.query(`
        WITH ${assignments}
        SELECT r.review_id, r.pair_id, r.stage_key, r.cycle_no, r.status,
               r.error_code, r.opened_at, r.checked_at, r.retry_requested_at,
               s.attempt_count, p.class_code, p.source_app_id,
               p.source_table_id, p.source_record_id,
               p.homework_file_id, p.source_link_index, p.essay_slot,
               p.task_type,
               coalesce(t.teacher_names,ARRAY[]::text[]) AS teacher_names
          FROM writing_flow.manual_review AS r
          JOIN writing_flow.pair AS p ON p.pair_id = r.pair_id
          LEFT JOIN teacher_assignments AS t USING (class_code)
          JOIN writing_flow.stage_result AS s
            ON s.pair_id = r.pair_id AND s.stage_key = r.stage_key
         WHERE r.status <> 'resolved'
         ORDER BY r.opened_at, r.review_id
         LIMIT $1 OFFSET $2`, [limit, offset]);
      return result.rows;
    },

    async requestRetry({ reviewId, requestId, actorRef }) {
      const normalizedRequestId = requestId.toLowerCase();
      return withTransaction(pool, async client => {
        const found = await client.query(`
          SELECT r.review_id, r.pair_id, r.stage_key, r.cycle_no,
                 r.status, r.retry_command_key,
                 s.status AS stage_status, s.attempt_count,
                 s.cycle_no AS stage_cycle_no,
                 p.status AS pair_status
            FROM writing_flow.manual_review AS r
            JOIN writing_flow.stage_result AS s
              ON s.pair_id = r.pair_id AND s.stage_key = r.stage_key
            JOIN writing_flow.pair AS p ON p.pair_id = r.pair_id
           WHERE r.review_id = $1
           FOR UPDATE OF r, s, p`, [reviewId]);
        if (found.rowCount !== 1) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Không tìm thấy bài cần kiểm tra.');
        const row = found.rows[0];
        if (row.retry_command_key === normalizedRequestId && row.status !== 'open') {
          return { reviewId, status: row.status, retryCommandKey: normalizedRequestId };
        }
        if (row.status !== 'open') {
          throw new ApiError(409, 'RETRY_ALREADY_REQUESTED', 'Bài đã có yêu cầu chạy lại.');
        }
        if (row.pair_status !== 'needs_review' || row.stage_status !== 'needs_review'
          || row.stage_cycle_no !== row.cycle_no || Number(row.attempt_count) !== 3) {
          throw new ApiError(409, 'REVIEW_STATE_CHANGED', 'Trạng thái bài đã thay đổi; hãy tải lại danh sách.');
        }
        const commandHash = crypto.createHash('sha256').update(normalizedRequestId).digest('hex');
        await client.query(`
          UPDATE writing_flow.manual_review
             SET status = 'retry_requested', checked_at = now(), checked_by = $2,
                 retry_command_key = $3, retry_requested_at = now()
           WHERE review_id = $1`, [reviewId, actorRef, normalizedRequestId]);
        await client.query(`
          INSERT INTO writing_flow.handoff
            (pair_id, from_stage, to_stage, source_result_sha256, status, next_send_at)
          VALUES ($1, 'review', $2, $3, 'pending', now())`,
        [row.pair_id, row.stage_key, commandHash]);
        return { reviewId, status: 'retry_requested', retryCommandKey: normalizedRequestId };
      });
    },
  };
}
