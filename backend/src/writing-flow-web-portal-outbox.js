import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { keyFromHex, open, sha256 } from './writing-flow-crypto.js';
import { buildSubstitutePortalRequest } from './writing-flow-web-portal-contract.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const FIELDS = {
  listening: 'Term Test 2 Listening (Thi lại)',
  reading: 'Term Test 2 Reading (Thi lại)',
  writing: 'Term Test 2 Writing (Thi lại)',
};

function readbackMatches(result, request) {
  if (result?.ok !== true || result.status !== 'synced'
    || result.externalWrite !== true || result.classCode !== 'IC2264'
    || result.attemptToken !== request.attemptToken
    || !result.actualScores || !result.portalScores || !result.portalFields
    || Object.keys(result.portalFields).length !== 3) return false;
  for (const [skill, field] of Object.entries(FIELDS)) {
    if (result.actualScores[skill] !== request.grades[skill]
      || result.portalScores[skill] !== result.portalFields[field]
      || typeof result.portalFields[field] !== 'number'
      || !Number.isFinite(result.portalFields[field])
      || result.portalFields[field] < 0 || result.portalFields[field] > 9
      || !Number.isInteger(result.portalFields[field] * 10)) return false;
  }
  return true;
}

// Dữ liệu vào: phiếu Portal được tạo cùng transaction chấm Writing.
// Việc chính: cấp lease riêng cho đúng một phiếu và dựng ba điểm từ bản mã hóa đã kiểm hash.
// Kết quả: trả yêu cầu xem trước, không trả bài viết hoặc tự ghi Portal.
// Khi lỗi: phiếu hỏng vào Cần kiểm tra, không chặn phiếu hợp lệ phía sau.
export function createWebSubstitutePortalOutbox({ pool, encryptionKey }) {
  const key = keyFromHex(encryptionKey);
  function ready() {
    if (!key) throw new ApiError(503, 'WEB_PORTAL_OUTBOX_NOT_READY',
      'Phiếu chờ ghi Portal chưa sẵn sàng.');
  }

  async function claimDue({ limit = 1 } = {}) {
    ready();
    if (!Number.isInteger(limit) || limit < 1 || limit > 4) {
      throw new ApiError(400, 'WEB_PORTAL_CLAIM_LIMIT_INVALID',
        'Số phiếu cần lấy không hợp lệ.');
    }
    const claim = await withTransaction(pool, async client => {
      const selected = await client.query(`SELECT submission_id
        FROM writing_flow.web_substitute_portal_outbox
        WHERE status='pending' AND next_attempt_at<=now() AND attempt_count<3
        ORDER BY next_attempt_at,created_at,submission_id
        FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]);
      const jobs = [];
      const reviewIds = [];
      for (const selectedRow of selected.rows) {
        const found = await client.query(`SELECT s.submission_id,s.attempt_id,
            s.task_number,s.status AS submission_status,s.task_score,
            s.content_ciphertext,s.content_sha256,a.test_slug,
            a.erp_course_class_id,a.erp_student_contact_id
          FROM writing_flow.web_substitute_submission AS s
          JOIN writing_flow.web_substitute_attempt AS a
            ON a.attempt_id=s.attempt_id
          WHERE s.submission_id=$1`, [selectedRow.submission_id]);
        const row = found.rows[0];
        let request;
        try {
          if (!row) throw new Error('SUBMISSION_MISSING');
          const contentText = open(row.content_ciphertext, key);
          if (sha256(contentText) !== row.content_sha256.trim()) {
            throw new Error('CONTENT_HASH_MISMATCH');
          }
          const content = JSON.parse(contentText);
          request = buildSubstitutePortalRequest({
            submissionId: row.submission_id, attemptId: row.attempt_id,
            testSlug: row.test_slug, classId: Number(row.erp_course_class_id),
            erpStudentId: Number(row.erp_student_contact_id),
            taskNumber: Number(row.task_number),
            submissionStatus: row.submission_status,
            sectionResults: content.sectionResults,
            taskScore: Number(row.task_score),
          });
        } catch {
          await client.query(`UPDATE writing_flow.web_substitute_portal_outbox
            SET status='needs_review',last_error_code='WEB_PORTAL_SOURCE_INVALID',
              updated_at=now()
            WHERE submission_id=$1 AND status='pending'`, [selectedRow.submission_id]);
          reviewIds.push(selectedRow.submission_id);
          continue;
        }
        const updated = await client.query(`UPDATE writing_flow.web_substitute_portal_outbox
          SET status='running',attempt_count=attempt_count+1,
            lease_token=gen_random_uuid(),lease_expires_at=now()+interval '10 minutes',
            updated_at=now()
          WHERE submission_id=$1 AND status='pending'
          RETURNING lease_token`, [row.submission_id]);
        if (updated.rows.length !== 1) {
          throw new ApiError(409, 'WEB_PORTAL_CLAIM_CONFLICT',
            'Phiếu đồng bộ đã được nhận ở nơi khác.');
        }
        jobs.push({ submissionId: row.submission_id,
          leaseToken: updated.rows[0].lease_token, request });
      }
      return { jobs, reviewIds };
    });
    for (const job of claim.jobs) {
      const checked = await pool.query(`SELECT status,lease_token
        FROM writing_flow.web_substitute_portal_outbox WHERE submission_id=$1`,
      [job.submissionId]);
      if (checked.rows.length !== 1 || checked.rows[0].status !== 'running'
        || checked.rows[0].lease_token !== job.leaseToken) {
        throw new ApiError(503, 'WEB_PORTAL_LEASE_READBACK_UNKNOWN',
          'Chưa xác nhận được quyền đồng bộ Portal.');
      }
    }
    if (claim.reviewIds.length) {
      const checked = await pool.query(`SELECT count(*)::int AS n
        FROM writing_flow.web_substitute_portal_outbox
        WHERE submission_id=ANY($1::uuid[]) AND status='needs_review'
          AND last_error_code='WEB_PORTAL_SOURCE_INVALID'`, [claim.reviewIds]);
      if (Number(checked.rows[0]?.n) !== claim.reviewIds.length) {
        throw new ApiError(503, 'WEB_PORTAL_REVIEW_READBACK_UNKNOWN',
          'Chưa xác nhận được phiếu nguồn lỗi cần kiểm tra.');
      }
    }
    return claim.jobs;
  }

  // Dữ liệu vào: kết quả writer đã tự đọc lại đủ ba cột và đúng lease phiếu.
  // Việc chính: kiểm kết quả writer khớp bài/lượt/ba điểm gốc rồi đánh dấu đồng bộ.
  // Kết quả: callback lặp cùng readback trả kết quả cũ, không ghi lần hai.
  // Khi lỗi: giữ phiếu để kiểm tay; không nhận xác nhận giả hoặc callback lệch.
  async function completeSync({ submissionId, leaseToken, result }) {
    ready();
    if (!UUID.test(String(submissionId || '')) || !UUID.test(String(leaseToken || ''))) {
      throw new ApiError(400, 'WEB_PORTAL_ID_INVALID', 'Mã phiếu chưa hợp lệ.');
    }
    const resultHash = sha256(JSON.stringify(result));
    const receipt = await withTransaction(pool, async client => {
      const found = await client.query(`SELECT o.*,s.attempt_id,s.task_number,
          s.status AS submission_status,s.task_score,s.content_ciphertext,
          s.content_sha256,a.test_slug,a.erp_course_class_id,
          a.erp_student_contact_id
        FROM writing_flow.web_substitute_portal_outbox AS o
        JOIN writing_flow.web_substitute_submission AS s
          ON s.submission_id=o.submission_id
        JOIN writing_flow.web_substitute_attempt AS a
          ON a.attempt_id=s.attempt_id
        WHERE o.submission_id=$1 FOR UPDATE OF o`, [submissionId]);
      const row = found.rows[0];
      if (!row) throw new ApiError(404, 'WEB_PORTAL_RECEIPT_NOT_FOUND',
        'Không có phiếu đồng bộ Portal.');
      if (row.status === 'synced') {
        if (row.completed_lease_token !== leaseToken
          || row.portal_receipt_sha256?.trim() !== resultHash) {
          throw new ApiError(409, 'WEB_PORTAL_RESULT_CONFLICT',
            'Phiếu đã đồng bộ với kết quả khác.');
        }
        return { submissionId, status: 'synced', receiptSha256: resultHash };
      }
      if (row.status !== 'running' || row.lease_token !== leaseToken
        || row.lease_expires_at <= new Date()) {
        throw new ApiError(409, 'WEB_PORTAL_LEASE_STALE',
          'Lượt đồng bộ đã hết hạn hoặc không còn hiệu lực.');
      }
      let request;
      try {
        const contentText = open(row.content_ciphertext, key);
        if (sha256(contentText) !== row.content_sha256.trim()) {
          throw new Error('CONTENT_HASH_MISMATCH');
        }
        const content = JSON.parse(contentText);
        request = buildSubstitutePortalRequest({
          submissionId, attemptId: row.attempt_id,
          testSlug: row.test_slug, classId: Number(row.erp_course_class_id),
          erpStudentId: Number(row.erp_student_contact_id),
          taskNumber: Number(row.task_number),
          submissionStatus: row.submission_status,
          sectionResults: content.sectionResults,
          taskScore: Number(row.task_score),
        });
      } catch {
        throw new ApiError(409, 'WEB_PORTAL_SOURCE_INVALID',
          'Phiếu gốc không còn hợp lệ để xác nhận Portal.');
      }
      if (!readbackMatches(result, request)) {
        throw new ApiError(409, 'WEB_PORTAL_READBACK_MISMATCH',
          'Kết quả đọc lại Portal không khớp bài/lượt/ba điểm.');
      }
      const updated = await client.query(`UPDATE writing_flow.web_substitute_portal_outbox
        SET status='synced',lease_token=NULL,lease_expires_at=NULL,
          portal_receipt_sha256=$2,completed_lease_token=$3,
          portal_fields=$4::jsonb,
          synced_at=now(),updated_at=now()
        WHERE submission_id=$1 AND status='running'
        RETURNING submission_id,status,portal_receipt_sha256`,
      [submissionId, resultHash, leaseToken,
        JSON.stringify(result.portalFields)]);
      return { submissionId: updated.rows[0].submission_id,
        status: updated.rows[0].status,
        receiptSha256: updated.rows[0].portal_receipt_sha256.trim() };
    });
    const checked = await pool.query(`SELECT status,portal_receipt_sha256,portal_fields
      FROM writing_flow.web_substitute_portal_outbox WHERE submission_id=$1`,
    [submissionId]);
    if (checked.rows.length !== 1 || checked.rows[0].status !== 'synced'
      || checked.rows[0].portal_receipt_sha256?.trim() !== resultHash
      || Object.entries(result.portalFields).some(([field, grade]) =>
        checked.rows[0].portal_fields?.[field] !== grade)) {
      throw new ApiError(503, 'WEB_PORTAL_READBACK_UNKNOWN',
        'Chưa xác nhận được trạng thái đồng bộ Portal.');
    }
    return receipt;
  }

  // Dữ liệu vào: lỗi writer hoặc lease hết hạn sau khi có thể đã ghi Portal.
  // Việc chính: dừng thử tự động và giữ phiếu để đối soát đúng cột trước khi tiếp tục.
  // Kết quả: trạng thái Cần kiểm tra, không xóa bài hay điểm đã có.
  // Khi lỗi: chỉ đúng lease mới được đổi trạng thái phiếu.
  async function markForReview({ submissionId, leaseToken, errorCode }) {
    ready();
    if (!UUID.test(String(submissionId || '')) || !UUID.test(String(leaseToken || ''))
      || !['WEB_PORTAL_PREVIEW_BLOCKED', 'WEB_PORTAL_WRITE_UNKNOWN',
        'WEB_PORTAL_READBACK_FAILED'].includes(errorCode)) {
      throw new ApiError(400, 'WEB_PORTAL_REVIEW_INVALID',
        'Lỗi đồng bộ Portal chưa hợp lệ.');
    }
    const changed = await pool.query(`UPDATE writing_flow.web_substitute_portal_outbox
      SET status='needs_review',lease_token=NULL,lease_expires_at=NULL,
        last_error_code=$3,updated_at=now()
      WHERE submission_id=$1 AND lease_token=$2 AND status='running'
      RETURNING submission_id,status`, [submissionId, leaseToken, errorCode]);
    if (changed.rows.length !== 1) throw new ApiError(409,
      'WEB_PORTAL_LEASE_STALE', 'Lượt đồng bộ không còn hiệu lực.');
    const checked = await pool.query(`SELECT status,last_error_code
      FROM writing_flow.web_substitute_portal_outbox WHERE submission_id=$1`,
    [submissionId]);
    if (checked.rows.length !== 1 || checked.rows[0].status !== 'needs_review'
      || checked.rows[0].last_error_code !== errorCode) {
      throw new ApiError(503, 'WEB_PORTAL_REVIEW_READBACK_UNKNOWN',
        'Chưa xác nhận được phiếu cần kiểm tra.');
    }
    return { submissionId, status: 'needs_review' };
  }

  async function markExpiredForReview({ limit = 100 } = {}) {
    ready();
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ApiError(400, 'WEB_PORTAL_SWEEP_LIMIT_INVALID',
        'Số phiếu cần kiểm chưa hợp lệ.');
    }
    const expired = await pool.query(`WITH due AS (
        SELECT submission_id FROM writing_flow.web_substitute_portal_outbox
        WHERE status='running' AND lease_expires_at<=now()
        ORDER BY lease_expires_at,submission_id LIMIT $1
        FOR UPDATE SKIP LOCKED
      ) UPDATE writing_flow.web_substitute_portal_outbox AS o
      SET status='needs_review',lease_token=NULL,lease_expires_at=NULL,
        last_error_code='WEB_PORTAL_LEASE_EXPIRED',updated_at=now()
      FROM due WHERE o.submission_id=due.submission_id
      RETURNING o.submission_id`, [limit]);
    if (expired.rows.length) {
      const checked = await pool.query(`SELECT count(*)::int AS n
        FROM writing_flow.web_substitute_portal_outbox
        WHERE submission_id=ANY($1::uuid[]) AND status='needs_review'
          AND last_error_code='WEB_PORTAL_LEASE_EXPIRED'`,
      [expired.rows.map(row => row.submission_id)]);
      if (Number(checked.rows[0]?.n) !== expired.rows.length) {
        throw new ApiError(503, 'WEB_PORTAL_REVIEW_READBACK_UNKNOWN',
          'Chưa xác nhận được phiếu quá hạn cần kiểm tra.');
      }
    }
    return { reviewed: expired.rows.length };
  }

  return { claimDue, completeSync, markForReview, markExpiredForReview };
}
