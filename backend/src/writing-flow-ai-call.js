import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { keyFromHex, open, seal, sha256 } from './writing-flow-crypto.js';

// Nhận vào: một nhóm câu của đúng cặp và lượt chấm đã cấp.
// Việc chính: lưu mã gọi AI; lần thử sau dùng lại kết quả chắc chắn thành công.
// Trả ra: mã gọi cổng AI hoặc kết quả đã lưu, chỉ qua API nội bộ.
// Khi lỗi: rollback; bài giữ nguyên trạng thái để chạy lại đúng bước.
export function createWritingFlowAiCall({ pool, encryptionKey }) {
  const key = keyFromHex(encryptionKey);
  function requireKey() {
    if (!key) throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY',
      'Chưa cấu hình nơi lưu bài chấm.');
  }

  async function start({ pairId, revision, stageKey, attemptId, batchIndex, prompt }) {
    requireKey();
    const promptSha256 = sha256(prompt);
    return withTransaction(pool, async client => {
      const pairResult = await client.query(`
        SELECT submission_revision,status FROM writing_flow.pair
        WHERE pair_id=$1 FOR UPDATE`, [pairId]);
      if (pairResult.rowCount !== 1) throw new ApiError(404, 'PAIR_NOT_FOUND', 'Không tìm thấy bài chấm.');
      const pair = pairResult.rows[0];
      if (pair.submission_revision !== revision || ['superseded', 'delivered'].includes(pair.status)) {
        throw new ApiError(409, 'PAIR_REVISION_CHANGED', 'Bài đã có phiên bản khác.');
      }
      const attemptResult = await client.query(`
        SELECT a.request_key,a.status,s.status AS stage_status
        FROM writing_flow.stage_attempt a
        JOIN writing_flow.stage_result s
          ON s.pair_id=a.pair_id AND s.stage_key=a.stage_key
        WHERE a.attempt_id=$1 AND a.pair_id=$2 AND a.stage_key=$3
        FOR UPDATE OF a,s`, [attemptId, pairId, stageKey]);
      if (attemptResult.rowCount !== 1 || attemptResult.rows[0].status !== 'sent'
        || attemptResult.rows[0].stage_status !== 'running') {
        throw new ApiError(409, 'AI_ATTEMPT_NOT_RUNNING', 'Lượt chấm không còn đang chạy.');
      }
      const existingResult = await client.query(`
        SELECT call_id,prompt_sha256,status,operation_key,result_ciphertext
        FROM writing_flow.ai_call WHERE attempt_id=$1 AND batch_index=$2
        FOR UPDATE`, [attemptId, batchIndex]);
      const existing = existingResult.rows[0];
      if (existing) {
        if (existing.prompt_sha256 !== promptSha256) {
          throw new ApiError(409, 'AI_PROMPT_CHANGED', 'Nội dung gửi AI đã đổi trong cùng lượt.');
        }
        return { callId: existing.call_id, operationKey: existing.operation_key,
          status: existing.status,
          result: existing.result_ciphertext ? JSON.parse(open(existing.result_ciphertext, key)) : null };
      }
      const priorResult = await client.query(`
        SELECT call_id,result_ciphertext,result_sha256
        FROM writing_flow.ai_call
        WHERE pair_id=$1 AND stage_key=$2 AND batch_index=$3
          AND prompt_sha256=$4 AND status='succeeded'
        ORDER BY finished_at DESC,call_id DESC LIMIT 1`,
      [pairId, stageKey, batchIndex, promptSha256]);
      const prior = priorResult.rows[0];
      const operationKey = 'writing:' + attemptResult.rows[0].request_key + ':' + batchIndex;
      const inserted = await client.query(`
        INSERT INTO writing_flow.ai_call
          (pair_id,stage_key,attempt_id,batch_index,operation_key,prompt_sha256,
           status,source_call_id,result_sha256,result_ciphertext,finished_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING call_id`, [pairId, stageKey, attemptId, batchIndex,
        operationKey, promptSha256, prior ? 'reused' : 'sent',
        prior?.call_id ?? null, prior?.result_sha256 ?? null,
        prior?.result_ciphertext ?? null, prior ? new Date() : null]);
      return { callId: inserted.rows[0].call_id, operationKey,
        status: prior ? 'reused' : 'sent',
        result: prior ? JSON.parse(open(prior.result_ciphertext, key)) : null };
    });
  }

  async function finish({ pairId, revision, stageKey, attemptId, batchIndex,
    operationKey, outcome, gatewayOperationId = null, provider = null,
    route = null, result = null, errorCode = null }) {
    requireKey();
    if (outcome === 'succeeded' && (!result || typeof result !== 'object'
      || Array.isArray(result))) {
      throw new ApiError(400, 'AI_RESULT_INVALID', 'Kết quả AI không hợp lệ.');
    }
    const resultJson = outcome === 'succeeded' ? JSON.stringify(result) : null;
    if (resultJson?.length > 500000) {
      throw new ApiError(400, 'AI_RESULT_TOO_LARGE', 'Kết quả AI vượt giới hạn.');
    }
    const resultSha = resultJson ? sha256(resultJson) : null;
    const resultCiphertext = resultJson ? seal(resultJson, key) : null;
    return withTransaction(pool, async client => {
      const pairResult = await client.query(`
        SELECT submission_revision FROM writing_flow.pair
        WHERE pair_id=$1 FOR UPDATE`, [pairId]);
      if (pairResult.rowCount !== 1 || pairResult.rows[0].submission_revision !== revision) {
        throw new ApiError(409, 'PAIR_REVISION_CHANGED', 'Bài đã có phiên bản khác.');
      }
      const callResult = await client.query(`
        SELECT call_id,status,operation_key,result_sha256
        FROM writing_flow.ai_call
        WHERE pair_id=$1 AND stage_key=$2 AND attempt_id=$3 AND batch_index=$4
        FOR UPDATE`, [pairId, stageKey, attemptId, batchIndex]);
      if (callResult.rowCount !== 1 || callResult.rows[0].operation_key !== operationKey) {
        throw new ApiError(409, 'AI_CALL_MISMATCH', 'Mã lần gọi AI không khớp bài.');
      }
      const call = callResult.rows[0];
      if (call.status === 'succeeded' && outcome === 'succeeded'
        && call.result_sha256 === resultSha) {
        return { callId: call.call_id, status: 'succeeded', alreadyRecorded: true };
      }
      if (call.status !== 'sent') {
        throw new ApiError(409, 'AI_CALL_ALREADY_FINISHED', 'Lần gọi AI đã được ghi nhận.');
      }
      await client.query(`
        UPDATE writing_flow.ai_call
        SET status=$2,gateway_operation_id=$3,provider=$4,route=$5,
            result_sha256=$6,result_ciphertext=$7,error_code=$8,finished_at=now()
        WHERE call_id=$1`, [call.call_id, outcome, gatewayOperationId,
        provider, route, resultSha, resultCiphertext, errorCode]);
      return { callId: call.call_id, status: outcome, alreadyRecorded: false };
    });
  }

  return { start, finish };
}
