import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { keyFromHex, open, seal, sha256 } from './writing-flow-crypto.js';
import { normalizeWritingTestResult } from './writing-flow-test.js';
import { WEB_SUBSTITUTE_PROFILES } from './writing-flow-web-identity.js';
import { pinnedWebPrompt } from './writing-flow-web-intake.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function sameIdentity(row, input) {
  return row.submission_id === input.submissionId
    && row.attempt_id === input.attemptId
    && row.run_key === input.runKey
    && row.test_slug === input.testSlug
    && Number(row.cohort) === WEB_SUBSTITUTE_PROFILES[input.testSlug]?.cohort
    && Number(row.erp_course_class_id) === Number(input.classId)
    && Number(row.erp_student_contact_id) === Number(input.erpStudentId)
    && Number(row.task_number) === Number(input.taskNumber)
    && row.rubric_version === input.rubricVersion
    && row.prompt_sha256.trim() === input.promptSha256
    && (row.image_sha256?.trim() || null) === (input.imageSha256 || null);
}

function checkWorkInput(input) {
  if (!input || !UUID.test(String(input.submissionId || ''))
    || !UUID.test(String(input.attemptId || ''))
    || !UUID.test(String(input.runKey || ''))
    || !UUID.test(String(input.leaseToken || ''))) {
    throw new ApiError(400, 'WEB_WORK_ID_INVALID', 'Mã công việc chưa hợp lệ.');
  }
}

function isPilotPortalTarget(row) {
  return row.test_slug === 'substitute-test-2-k56'
    && Number(row.erp_course_class_id) === 1252
    && Number(row.task_number) === 1;
}

// Dữ liệu vào: bài IC2264 đã có kết quả Writing hợp lệ trong transaction hiện tại.
// Việc chính: bảo đảm đúng một phiếu chờ đồng bộ Portal, kể cả callback lặp.
// Kết quả: phiếu chỉ được tạo khi bài đã chấm xong, chưa ghi điểm ra ngoài.
// Khi lỗi: transaction chấm rollback để không có kết quả mà thiếu phiếu đồng bộ.
async function ensurePilotPortalOutbox(client, row) {
  if (!isPilotPortalTarget(row)) return false;
  await client.query(`INSERT INTO writing_flow.web_substitute_portal_outbox
    (submission_id) VALUES ($1) ON CONFLICT (submission_id) DO NOTHING`,
  [row.submission_id]);
  return true;
}

// Dữ liệu vào: kết quả Task 1 từ bộ chấm Substitute 2 K56 đã dùng lâu nay.
// Việc chính: đổi đúng hai mã TA cũ sang tên chuẩn mà backend lưu, không sửa nhận xét/điểm.
// Kết quả: bộ kiểm chung vẫn đòi đủ bốn tiêu chí và chín khía cạnh.
// Khi lỗi: mã thiếu, trùng hoặc lạ giữ nguyên để bộ kiểm chung từ chối.
function adaptProvenPizzaResult(input) {
  if (input.testSlug !== 'substitute-test-2-k56' || Number(input.taskNumber) !== 1) {
    return input.result;
  }
  const source = input.result?.testResult || input.result?.result || input.result;
  if (!Array.isArray(source?.criteria)) return input.result;
  const ta = source.criteria.find(item => String(item?.code || '').trim().toUpperCase() === 'TA');
  if (!Array.isArray(ta?.components)) return input.result;
  const codes = ta.components.map(item => String(item?.code || '').trim());
  if (codes.length !== 2
    || !codes.includes('ta_overview') || !codes.includes('ta_data')) {
    return input.result;
  }
  const mapped = { ...source, criteria: source.criteria.map(criterion =>
    criterion !== ta ? criterion : { ...criterion,
      components: criterion.components.map(component => ({ ...component,
        code: component.code === 'ta_overview' ? 'ta_key_features_overview'
          : 'ta_data_support',
      })) }) };
  if (input.result?.testResult) return { ...input.result, testResult: mapped };
  if (input.result?.result) return { ...input.result, result: mapped };
  return mapped;
}

export function normalizeWebSubstituteGradingResult(input) {
  return normalizeWritingTestResult(input.taskNumber, adaptProvenPizzaResult(input));
}

// Dữ liệu vào: phiếu web đã commit và đến hạn trong cùng database Writing.
// Việc chính: khóa từng phiếu, kiểm nội dung/đề rồi cấp lease; các bộ lấy việc không trùng.
// Kết quả: job giữ runKey cũ và leaseToken mới cho đúng bộ chấm chuyên môn đã ghim.
// Khi lỗi: không trả job nếu chưa đọc lại lease; timeout đưa về Cần kiểm tra.
export function createWebSubstituteQueue({ pool, encryptionKey, getPinnedPrompt }) {
  const key = keyFromHex(encryptionKey);
  function ready() {
    if (!key || typeof getPinnedPrompt !== 'function') {
      throw new ApiError(503, 'WEB_QUEUE_NOT_READY', 'Hàng chờ bài web chưa sẵn sàng.');
    }
  }

  async function claimDue({ limit = 1 } = {}) {
    ready();
    if (!Number.isInteger(limit) || limit < 1 || limit > 4) {
      throw new ApiError(400, 'WEB_CLAIM_LIMIT_INVALID', 'Số bài lấy không hợp lệ.');
    }
    const claim = await withTransaction(pool, async client => {
      // Khóa ngắn bảo đảm nhiều poller không cùng vượt trần bốn bài web đang chạy.
      await client.query(`SELECT pg_advisory_xact_lock(
        hashtext('writing_flow_web_substitute_claim_capacity'))`);
      const active = await client.query(`SELECT count(*)::int AS n
        FROM writing_flow.web_substitute_submission
        WHERE status='running' AND lease_expires_at>now()`);
      const available = Math.max(0, 4 - Number(active.rows[0].n));
      if (available === 0) return { jobs: [], reviewIds: [] };
      const due = await client.query(`SELECT submission_id
        FROM writing_flow.web_substitute_submission
        WHERE status='pending' AND next_attempt_at<=now() AND attempt_count<3
        ORDER BY next_attempt_at,created_at,submission_id
        FOR UPDATE SKIP LOCKED LIMIT $1`, [Math.min(limit, available)]);
      const claimed = [];
      const reviewIds = [];
      for (const dueRow of due.rows) {
        const result = await client.query(`SELECT s.*,a.test_slug,a.cohort,
            a.erp_course_class_id,a.erp_student_contact_id,a.rubric_version
          FROM writing_flow.web_substitute_submission AS s
          JOIN writing_flow.web_substitute_attempt AS a
            ON a.attempt_id=s.attempt_id
          WHERE s.submission_id=$1`, [dueRow.submission_id]);
        const row = result.rows[0];
        if (!row) throw new ApiError(503, 'WEB_WORK_ROW_MISSING',
          'Chưa đọc lại được bài chờ đã chọn.');
        let content;
        let pinned;
        try {
          const profile = WEB_SUBSTITUTE_PROFILES[row.test_slug];
          if (!profile || Number(row.cohort) !== profile.cohort
            || !profile.tasks.includes(Number(row.task_number))) {
            throw new Error('WEB_WORK_IDENTITY_MISMATCH');
          }
          const contentText = open(row.content_ciphertext, key);
          if (sha256(contentText) !== row.content_sha256.trim()) {
            throw new Error('WEB_WORK_CONTENT_MISMATCH');
          }
          content = JSON.parse(contentText);
          pinned = pinnedWebPrompt(getPinnedPrompt,
            { testSlug: row.test_slug }, Number(row.task_number), row.rubric_version);
          if (Number(content.taskNumber) !== Number(row.task_number)
            || content.topic !== pinned.topic
            || content.imageUrl !== (pinned.imageUrl || '')
            || typeof content.essay !== 'string'
            || row.prompt_sha256.trim() !== pinned.promptSha256
            || (row.image_sha256?.trim() || null) !== (pinned.imageSha256 || null)) {
            throw new Error('WEB_WORK_PROMPT_MISMATCH');
          }
        } catch {
          // Một bài hỏng không chặn các bài hợp lệ phía sau trong hàng chờ.
          await client.query(`UPDATE writing_flow.web_substitute_submission
            SET status='needs_review',last_error_code='WEB_WORK_VALIDATION_FAILED',
              updated_at=now()
            WHERE submission_id=$1 AND status='pending'`, [row.submission_id]);
          reviewIds.push(row.submission_id);
          continue;
        }
        const lease = await client.query(`UPDATE writing_flow.web_substitute_submission
          SET status='running',attempt_count=attempt_count+1,
            lease_token=gen_random_uuid(),lease_expires_at=now()+interval '90 minutes',
            updated_at=now()
          WHERE submission_id=$1 AND status='pending'
          RETURNING lease_token,attempt_count`, [row.submission_id]);
        if (lease.rows.length !== 1) {
          throw new ApiError(409, 'WEB_WORK_CLAIM_CONFLICT',
            'Bài chờ đã được bộ khác nhận.');
        }
        claimed.push({ submissionId: row.submission_id, attemptId: row.attempt_id,
          runKey: row.run_key, leaseToken: lease.rows[0].lease_token,
          attemptNumber: Number(lease.rows[0].attempt_count),
          source: 'substitute_web', testSlug: row.test_slug,
          cohort: Number(row.cohort), classId: Number(row.erp_course_class_id),
          erpStudentId: Number(row.erp_student_contact_id),
          taskNumber: Number(row.task_number), rubricVersion: row.rubric_version,
          promptSha256: row.prompt_sha256.trim(),
          imageSha256: row.image_sha256?.trim() || null,
          prompt: pinned.topic, imageUrl: pinned.imageUrl || null,
          essay: content.essay,
          wordCount: content.essay.trim().split(/\s+/u).length });
      }
      return { jobs: claimed, reviewIds };
    });
    for (const job of claim.jobs) {
      const readback = await pool.query(`SELECT status,lease_token,run_key
        FROM writing_flow.web_substitute_submission WHERE submission_id=$1`,
      [job.submissionId]);
      if (readback.rows.length !== 1 || readback.rows[0].status !== 'running'
        || readback.rows[0].lease_token !== job.leaseToken
        || readback.rows[0].run_key !== job.runKey) {
        throw new ApiError(503, 'WEB_LEASE_READBACK_UNKNOWN',
          'Chưa xác nhận được quyền xử lý bài chờ.');
      }
    }
    if (claim.reviewIds.length) {
      const readback = await pool.query(`SELECT count(*)::int AS n
        FROM writing_flow.web_substitute_submission
        WHERE submission_id=ANY($1::uuid[]) AND status='needs_review'
          AND last_error_code='WEB_WORK_VALIDATION_FAILED'`, [claim.reviewIds]);
      if (Number(readback.rows[0]?.n) !== claim.reviewIds.length) {
        throw new ApiError(503, 'WEB_REVIEW_READBACK_UNKNOWN',
          'Chưa xác nhận được bài cần kiểm tra.');
      }
    }
    return claim.jobs;
  }

  // Dữ liệu vào: kết quả bốn tiêu chí từ đúng job/lease của bộ chấm cũ.
  // Việc chính: tính lại điểm ở backend, mã hóa kết quả và ghi một lần theo identity.
  // Kết quả: callback lặp cùng dữ liệu trả đúng kết quả cũ; callback muộn/sai bị chặn.
  // Khi lỗi: không ghi đè điểm hoặc trả kết quả sang lớp, đề, Task khác.
  async function completeWork(input) {
    ready();
    checkWorkInput(input);
    const normalized = normalizeWebSubstituteGradingResult(input);
    const resultText = JSON.stringify(normalized);
    const resultSha256 = sha256(resultText);
    const receipt = await withTransaction(pool, async client => {
      const found = await client.query(`SELECT s.*,a.test_slug,a.cohort,
          a.erp_course_class_id,a.erp_student_contact_id,a.rubric_version
        FROM writing_flow.web_substitute_submission AS s
        JOIN writing_flow.web_substitute_attempt AS a ON a.attempt_id=s.attempt_id
        WHERE s.submission_id=$1 FOR UPDATE OF s`, [input.submissionId]);
      const row = found.rows[0];
      if (found.rows.length !== 1 || !sameIdentity(row, input)) {
        throw new ApiError(409, 'WEB_WORK_IDENTITY_MISMATCH',
          'Kết quả không khớp nguồn, lớp, học viên, lượt hoặc Task.');
      }
      if (row.status === 'completed' || row.status === 'delivered') {
        if (row.result_sha256?.trim() !== resultSha256) {
          throw new ApiError(409, 'WEB_RESULT_CONFLICT',
            'Bài đã có kết quả khác.');
        }
        const portalOutboxRequired = await ensurePilotPortalOutbox(client, row);
        return { submissionId: row.submission_id, taskScore: Number(row.task_score),
          status: row.status, portalOutboxRequired };
      }
      if (row.status !== 'running' || row.lease_token !== input.leaseToken
        || row.lease_expires_at <= new Date()) {
        throw new ApiError(409, 'WEB_WORK_LEASE_STALE',
          'Lượt xử lý đã hết hạn hoặc không còn hiệu lực.');
      }
      const updated = await client.query(`UPDATE writing_flow.web_substitute_submission
        SET status='completed',lease_token=NULL,lease_expires_at=NULL,
          result_ciphertext=$2,result_sha256=$3,task_score=$4,
          completed_at=now(),updated_at=now()
        WHERE submission_id=$1 AND status='running'
        RETURNING submission_id,status,task_score`, [row.submission_id,
        seal(resultText, key), resultSha256, normalized.taskScore]);
      await client.query(`UPDATE writing_flow.web_substitute_attempt
        SET status='completed',updated_at=now() WHERE attempt_id=$1`,
      [row.attempt_id]);
      const portalOutboxRequired = await ensurePilotPortalOutbox(client, row);
      return { submissionId: updated.rows[0].submission_id,
        status: updated.rows[0].status,
        taskScore: Number(updated.rows[0].task_score), portalOutboxRequired };
    });
    const readback = await pool.query(`SELECT status,result_sha256,task_score
      FROM writing_flow.web_substitute_submission WHERE submission_id=$1`,
    [receipt.submissionId]);
    if (readback.rows.length !== 1
      || readback.rows[0].result_sha256?.trim() !== resultSha256
      || Number(readback.rows[0].task_score) !== receipt.taskScore) {
      throw new ApiError(503, 'WEB_RESULT_READBACK_UNKNOWN',
        'Chưa xác nhận được kết quả đã lưu.');
    }
    if (receipt.portalOutboxRequired) {
      const outbox = await pool.query(`SELECT submission_id FROM
        writing_flow.web_substitute_portal_outbox WHERE submission_id=$1`,
      [receipt.submissionId]);
      if (outbox.rows.length !== 1) {
        throw new ApiError(503, 'WEB_PORTAL_OUTBOX_READBACK_UNKNOWN',
          'Chưa xác nhận được phiếu chờ đồng bộ Portal.');
      }
    }
    return receipt;
  }

  // Dữ liệu vào: báo lỗi của đúng lease, phân biệt lỗi chắc chắn với kết quả chưa rõ.
  // Việc chính: chỉ thử lại lỗi xảy ra trước tác động AI; tối đa ba lượt có giãn cách.
  // Kết quả: lỗi bất định/hết lượt vào Cần kiểm tra, không tự chấm trùng.
  // Khi lỗi: callback cũ hoặc mã lỗi ngoài danh sách không đổi hàng chờ.
  async function reportFailure(input) {
    ready();
    checkWorkInput(input);
    const allowed = new Set(['WEB_GRADER_PRECHECK_FAILED',
      'WEB_GRADER_RATE_LIMITED', 'WEB_GRADER_OUTPUT_INVALID',
      'WEB_GRADER_RESULT_UNKNOWN']);
    if (!allowed.has(input.errorCode) || typeof input.definiteFailure !== 'boolean') {
      throw new ApiError(400, 'WEB_FAILURE_INVALID', 'Loại lỗi chấm chưa hợp lệ.');
    }
    const safeToRetry = input.definiteFailure === true
      && ['WEB_GRADER_PRECHECK_FAILED', 'WEB_GRADER_RATE_LIMITED']
        .includes(input.errorCode);
    const receipt = await withTransaction(pool, async client => {
      const found = await client.query(`SELECT s.*,a.test_slug,a.cohort,
          a.erp_course_class_id,a.erp_student_contact_id,a.rubric_version
        FROM writing_flow.web_substitute_submission AS s
        JOIN writing_flow.web_substitute_attempt AS a ON a.attempt_id=s.attempt_id
        WHERE s.submission_id=$1 FOR UPDATE OF s`, [input.submissionId]);
      const row = found.rows[0];
      if (found.rows.length !== 1 || !sameIdentity(row, input)) {
        throw new ApiError(409, 'WEB_WORK_IDENTITY_MISMATCH',
          'Lỗi không khớp công việc đã lưu.');
      }
      if (row.status !== 'running' || row.lease_token !== input.leaseToken
        || row.lease_expires_at <= new Date()) {
        throw new ApiError(409, 'WEB_WORK_LEASE_STALE',
          'Lượt xử lý đã hết hạn hoặc không còn hiệu lực.');
      }
      const retry = safeToRetry && Number(row.attempt_count) < 3;
      const nextSeconds = Number(row.attempt_count) === 1 ? 60 : 300;
      const updated = await client.query(`UPDATE writing_flow.web_substitute_submission
        SET status=$2,lease_token=NULL,lease_expires_at=NULL,
          next_attempt_at=CASE WHEN $3::boolean THEN now()+($4::integer * interval '1 second')
            ELSE next_attempt_at END,
          last_error_code=$5,updated_at=now()
        WHERE submission_id=$1 RETURNING submission_id,status,next_attempt_at`,
      [row.submission_id, retry ? 'pending' : 'needs_review', retry,
        nextSeconds, input.errorCode]);
      return { submissionId: updated.rows[0].submission_id,
        status: updated.rows[0].status,
        nextAttemptAt: retry ? updated.rows[0].next_attempt_at : null };
    });
    const readback = await pool.query(`SELECT status,last_error_code
      FROM writing_flow.web_substitute_submission WHERE submission_id=$1`,
    [receipt.submissionId]);
    if (readback.rows.length !== 1 || readback.rows[0].status !== receipt.status
      || readback.rows[0].last_error_code !== input.errorCode) {
      throw new ApiError(503, 'WEB_FAILURE_READBACK_UNKNOWN',
        'Chưa xác nhận được trạng thái lỗi chấm.');
    }
    return receipt;
  }

  // Dữ liệu vào: lease quá hạn, có thể là AI vẫn chạy hoặc mất callback.
  // Việc chính: dừng trạng thái vô hạn, giữ bài/phiếu để người vận hành đối chiếu.
  // Kết quả: số phiếu cần kiểm tra; không tự gọi AI lại khi kết quả còn bất định.
  async function markExpiredForReview({ limit = 100 } = {}) {
    ready();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(400, 'WEB_SWEEP_LIMIT_INVALID', 'Số bài kiểm chưa hợp lệ.');
    }
    const result = await pool.query(`WITH expired AS (
        SELECT submission_id FROM writing_flow.web_substitute_submission
        WHERE status='running' AND lease_expires_at<=now()
        ORDER BY lease_expires_at,submission_id
        FOR UPDATE SKIP LOCKED LIMIT $1
      ) UPDATE writing_flow.web_substitute_submission AS s
        SET status='needs_review',lease_token=NULL,lease_expires_at=NULL,
          last_error_code='WEB_WORK_LEASE_EXPIRED',updated_at=now()
        FROM expired WHERE s.submission_id=expired.submission_id
        RETURNING s.submission_id`, [limit]);
    if (result.rows.length) {
      const ids = result.rows.map(row => row.submission_id);
      const readback = await pool.query(`SELECT count(*)::int AS n
        FROM writing_flow.web_substitute_submission
        WHERE submission_id=ANY($1::uuid[]) AND status='needs_review'
          AND last_error_code='WEB_WORK_LEASE_EXPIRED'`, [ids]);
      if (Number(readback.rows[0]?.n) !== ids.length) {
        throw new ApiError(503, 'WEB_SWEEP_READBACK_UNKNOWN',
          'Chưa xác nhận được trạng thái bài quá hạn.');
      }
    }
    return { needsReview: result.rows.length };
  }

  return { claimDue, completeWork, reportFailure, markExpiredForReview };
}
