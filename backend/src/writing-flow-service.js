import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { createWritingFlowIntake } from './writing-flow-intake.js';

// Nhận vào: pool PostgreSQL và yêu cầu của quản trị viên đã xác thực.
// Việc chính: chỉ đọc trạng thái từng cặp hoặc ghi yêu cầu chạy lại vào hàng bàn giao bền.
// Trả ra: trạng thái, mã cặp và bước; không đọc bài làm hay kết quả đã mã hóa.
// Khi lỗi: transaction hoàn tác; màn hình nhận mã lỗi và giữ mục Cần kiểm tra.
export function createWritingFlowService({ pool, encryptionKey = null }) {
  return {
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
        SELECT issue_key,source_app_id,source_table_id,source_record_id,
               homework_file_id,source_link_index,
               essay_slot,class_code,reason_code,occurrence_count,first_seen_at,last_seen_at
          FROM writing_flow.source_issue WHERE status='open'
         ORDER BY last_seen_at DESC,issue_key
         LIMIT $1 OFFSET $2`, [limit, offset]);
      return result.rows;
    },
    async summary() {
      const result = await pool.query(`
        SELECT class_code, status, count(*)::integer AS pair_count
          FROM writing_flow.pair
         GROUP BY class_code, status
         ORDER BY class_code, status`);
      return result.rows;
    },

    async listPairs({ classCode = null, limit = 100, offset = 0 } = {}) {
      const result = await pool.query(`
        SELECT p.pair_id, p.class_code, p.source_app_id, p.source_table_id,
               p.source_record_id, p.homework_file_id,
               p.source_link_index, p.essay_slot, p.task_type, p.status,
               p.created_at, p.updated_at,
               current_stage.stage_key, current_stage.stage_status,
               current_stage.attempt_count
          FROM writing_flow.pair AS p
          LEFT JOIN LATERAL (
            SELECT s.stage_key, s.status AS stage_status, s.attempt_count
              FROM writing_flow.stage_result AS s
             WHERE s.pair_id = p.pair_id
             ORDER BY s.updated_at DESC, s.stage_key
             LIMIT 1
          ) AS current_stage ON true
         WHERE ($1::text IS NULL OR p.class_code = $1)
         ORDER BY p.updated_at DESC, p.pair_id DESC
         LIMIT $2 OFFSET $3`, [classCode, limit, offset]);
      return result.rows;
    },

    // Nhận vào: mã của đúng một cặp đề–bài do quản trị viên chọn trên trang.
    // Việc chính: ghép các mốc giai đoạn, lần thử, AI, bàn giao và kiểm tra thành lịch sử theo giờ.
    // Trả ra: mã kỹ thuật, trạng thái và lỗi; không truy vấn bài viết, prompt hoặc kết quả đã mã hóa.
    // Khi không thấy bài: trả 404 để trang không nhầm lịch sử của một bài khác.
    async pairHistory({ pairId }) {
      const found = await pool.query(`SELECT pair_id,class_code,task_type,essay_slot,status
        FROM writing_flow.pair WHERE pair_id=$1`, [pairId]);
      if (!found.rowCount) throw new ApiError(404, 'WRITING_PAIR_NOT_FOUND', 'Không tìm thấy bài này.');
      const [stages, attempts, aiCalls, handoffs, reviews] = await Promise.all([
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
      ]);
      const events = [
        ...stages.rows.map(row => ({ kind: 'stage', at: row.updated_at, ...row })),
        ...attempts.rows.map(row => ({ kind: 'attempt', at: row.finished_at || row.started_at, ...row })),
        ...aiCalls.rows.map(row => ({ kind: 'ai_call', at: row.finished_at || row.created_at, ...row })),
        ...handoffs.rows.map(row => ({ kind: 'handoff', at: row.acknowledged_at || row.last_sent_at || row.created_at, ...row })),
        ...reviews.rows.map(row => ({ kind: 'review', at: row.resolved_at || row.retry_accepted_at || row.retry_requested_at || row.opened_at, ...row })),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      return { pair: found.rows[0], events };
    },

    async listReviews({ limit = 100, offset = 0 } = {}) {
      const result = await pool.query(`
        SELECT r.review_id, r.pair_id, r.stage_key, r.cycle_no, r.status,
               r.error_code, r.opened_at, r.checked_at, r.retry_requested_at,
               s.attempt_count, p.class_code, p.source_app_id,
               p.source_table_id, p.source_record_id,
               p.homework_file_id, p.source_link_index, p.essay_slot,
               p.task_type
          FROM writing_flow.manual_review AS r
          JOIN writing_flow.pair AS p ON p.pair_id = r.pair_id
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
