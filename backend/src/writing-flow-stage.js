import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { keyFromHex, open, seal, sha256 } from './writing-flow-crypto.js';

const STAGES = ['precheck', 'main', 'critic', 'arbiter', 'render', 'deliver'];
const LEASE_SECONDS = { precheck: 600, main: 600, critic: 600, arbiter: 600, render: 300, deliver: 180 };
const NEXT = { precheck: ['main'], main: ['critic'], critic: ['arbiter', 'render'],
  arbiter: ['render'], render: ['deliver'], deliver: [null] };

function decode(value, key) {
  return JSON.parse(open(value, key));
}

// Nhận vào: mã cặp, phiên bản và yêu cầu bàn giao đã ghi bền.
// Việc chính: khóa cặp/bước, chống nhận hai lần, cấp lượt thử và nạp thành quả đã mã hóa.
// Trả ra: đúng đầu vào của một giai đoạn hoặc trạng thái đã chạy/chưa được phép.
// Khi lỗi: rollback; không đánh dấu bàn giao đã nhận nếu chưa tạo được lượt thử.
export function createWritingFlowStage({ pool, encryptionKey }) {
  const key = keyFromHex(encryptionKey);
  async function claim({ pairId, revision, stageKey, handoffId, executionId }) {
    if (!key) throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY', 'Chưa cấu hình nơi lưu bài chấm.');
    if (!STAGES.includes(stageKey)) throw new ApiError(400, 'STAGE_INVALID', 'Bước chấm không hợp lệ.');
    return withTransaction(pool, async client => {
      const pairResult = await client.query(`
        SELECT pair_id, submission_revision, status, source_ciphertext
          FROM writing_flow.pair WHERE pair_id = $1 FOR UPDATE`, [pairId]);
      if (pairResult.rowCount !== 1) throw new ApiError(404, 'PAIR_NOT_FOUND', 'Không tìm thấy bài chấm.');
      const pair = pairResult.rows[0];
      if (pair.submission_revision !== revision) {
        throw new ApiError(409, 'PAIR_REVISION_CHANGED', 'Bài đã có phiên bản khác.');
      }
      const handoffResult = await client.query(`
        SELECT handoff_id, from_stage, to_stage, source_result_sha256, status
          FROM writing_flow.handoff
         WHERE handoff_id = $1 AND pair_id = $2 FOR UPDATE`, [handoffId, pairId]);
      if (handoffResult.rowCount !== 1 || handoffResult.rows[0].to_stage !== stageKey) {
        throw new ApiError(409, 'HANDOFF_MISMATCH', 'Yêu cầu bàn giao không khớp bài và bước.');
      }
      const handoff = handoffResult.rows[0];
      if (pair.status === 'superseded') {
        await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',
          acknowledged_at=now() WHERE handoff_id=$1`, [handoffId]);
        return { status: 'superseded', pairId, stageKey };
      }
      if (pair.status === 'delivered') {
        await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',
          acknowledged_at=now() WHERE handoff_id=$1`, [handoffId]);
        return { status: 'already_delivered', pairId, stageKey };
      }
      if (handoff.from_stage !== 'review' && handoff.from_stage !== 'retry') {
        await client.query(`
          INSERT INTO writing_flow.stage_result
            (pair_id, stage_key, status, input_sha256)
          VALUES ($1,$2,'pending',$3)
          ON CONFLICT (pair_id,stage_key) DO NOTHING`,
        [pairId, stageKey, handoff.source_result_sha256]);
      }
      const stageResult = await client.query(`
        SELECT pair_id, stage_key, status, cycle_no, attempt_count,
               input_sha256, lease_expires_at
          FROM writing_flow.stage_result
         WHERE pair_id=$1 AND stage_key=$2 FOR UPDATE`, [pairId, stageKey]);
      if (stageResult.rowCount !== 1) {
        throw new ApiError(409, 'STAGE_NOT_READY', 'Bước chấm chưa có nguồn hợp lệ.');
      }
      let stage = stageResult.rows[0];
      if (stage.status === 'succeeded' || stage.status === 'skipped') {
        await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',
          acknowledged_at=now() WHERE handoff_id=$1`, [handoffId]);
        return { status: 'already_finished', pairId, stageKey };
      }
      if (handoff.from_stage === 'review') {
        const reviewResult = await client.query(`
          SELECT review_id, cycle_no, status, retry_command_key
            FROM writing_flow.manual_review
           WHERE pair_id=$1 AND stage_key=$2 AND status='retry_requested'
           FOR UPDATE`, [pairId, stageKey]);
        const review = reviewResult.rows[0];
        if (reviewResult.rowCount !== 1 || stage.status !== 'needs_review'
          || review.cycle_no !== stage.cycle_no
          || sha256(review.retry_command_key) !== handoff.source_result_sha256) {
          throw new ApiError(409, 'REVIEW_RETRY_MISMATCH', 'Yêu cầu chạy lại sau kiểm tra không khớp.');
        }
        await client.query(`
          UPDATE writing_flow.manual_review
             SET status='retry_accepted', retry_accepted_at=now()
           WHERE review_id=$1`, [review.review_id]);
        await client.query(`
          UPDATE writing_flow.stage_result
             SET status='pending', cycle_no=cycle_no+1, attempt_count=0,
                 error_code=NULL, started_at=NULL, lease_expires_at=NULL,
                 updated_at=now()
           WHERE pair_id=$1 AND stage_key=$2`, [pairId, stageKey]);
        stage = { ...stage, status: 'pending', cycle_no: stage.cycle_no + 1, attempt_count: 0 };
        await client.query(`UPDATE writing_flow.pair SET status='running',updated_at=now()
          WHERE pair_id=$1`, [pairId]);
      } else if (handoff.from_stage !== 'retry'
        && stage.input_sha256 !== handoff.source_result_sha256) {
        throw new ApiError(409, 'STAGE_INPUT_CHANGED', 'Đầu vào bước chấm không khớp bản đã lưu.');
      }
      if (stage.status === 'needs_review') return { status: 'needs_review', pairId, stageKey };
      if (stage.status === 'running' && stage.lease_expires_at
        && new Date(stage.lease_expires_at).getTime() > Date.now()) {
        return { status: 'already_running', pairId, stageKey };
      }
      if (stage.status === 'running') {
        await client.query(`
          UPDATE writing_flow.stage_attempt
             SET status='unknown', error_code='STAGE_TIMEOUT', finished_at=now()
           WHERE pair_id=$1 AND stage_key=$2 AND cycle_no=$3
             AND attempt_no=$4 AND status='sent'`,
        [pairId, stageKey, stage.cycle_no, stage.attempt_count]);
      }
      if (stage.attempt_count >= 3) {
        await client.query(`UPDATE writing_flow.stage_result
          SET status='needs_review',error_code='STAGE_TIMEOUT',lease_expires_at=NULL,
              updated_at=now() WHERE pair_id=$1 AND stage_key=$2`, [pairId, stageKey]);
        await client.query(`UPDATE writing_flow.pair SET status='needs_review',updated_at=now()
          WHERE pair_id=$1`, [pairId]);
        await client.query(`UPDATE writing_flow.manual_review
          SET status='resolved',resolved_at=now()
          WHERE pair_id=$1 AND stage_key=$2 AND status<>'resolved'`, [pairId, stageKey]);
        await client.query(`
          INSERT INTO writing_flow.manual_review
            (pair_id, stage_key, cycle_no, error_code)
          VALUES ($1,$2,$3,'STAGE_TIMEOUT')
          ON CONFLICT (pair_id,stage_key,cycle_no) DO NOTHING`,
        [pairId, stageKey, stage.cycle_no]);
        return { status: 'needs_review', pairId, stageKey };
      }
      const attemptNo = Number(stage.attempt_count) + 1;
      const requestKey = crypto.randomUUID();
      const attemptResult = await client.query(`
        INSERT INTO writing_flow.stage_attempt
          (pair_id,stage_key,cycle_no,attempt_no,request_key,status,n8n_execution_id)
        VALUES ($1,$2,$3,$4,$5,'sent',$6)
        RETURNING attempt_id`,
      [pairId, stageKey, stage.cycle_no, attemptNo, requestKey, executionId]);
      await client.query(`
        UPDATE writing_flow.stage_result
           SET status='running', attempt_count=$3, n8n_execution_id=$4,
               started_at=now(), lease_expires_at=now()+($5::integer*interval '1 second'),
               updated_at=now()
         WHERE pair_id=$1 AND stage_key=$2`,
      [pairId, stageKey, attemptNo, executionId, LEASE_SECONDS[stageKey]]);
      await client.query(`UPDATE writing_flow.pair SET status='running',updated_at=now()
        WHERE pair_id=$1`, [pairId]);
      await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',
        acknowledged_at=now() WHERE handoff_id=$1`, [handoffId]);
      const results = await client.query(`
        SELECT stage_key,result_ciphertext
          FROM writing_flow.stage_result
         WHERE pair_id=$1 AND status='succeeded'
         ORDER BY CASE stage_key
           WHEN 'intake' THEN 1 WHEN 'precheck' THEN 2 WHEN 'main' THEN 3
           WHEN 'critic' THEN 4 WHEN 'arbiter' THEN 5 WHEN 'render' THEN 6 ELSE 7 END`, [pairId]);
      return {
        status: 'started', pairId, revision, stageKey,
        attemptId: attemptResult.rows[0].attempt_id, attemptNo,
        requestKey, cycleNo: stage.cycle_no,
        source: (() => {
          const [taskType, topic, image, essay] = decode(pair.source_ciphertext, key);
          return { taskType, topic, image, essay };
        })(),
        previous: Object.fromEntries(results.rows.map(row => [row.stage_key, decode(row.result_ciphertext, key)])),
      };
    });
  }

  // Một kết quả hợp lệ đến trước được chốt; callback đến muộn vẫn lưu nhưng không ghi đè.
  async function complete({ pairId, revision, stageKey, attemptId, result, nextStage }) {
    if (!key) throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY', 'Chưa cấu hình nơi lưu bài chấm.');
    if (!STAGES.includes(stageKey) || !NEXT[stageKey].includes(nextStage)) {
      throw new ApiError(400, 'STAGE_TRANSITION_INVALID', 'Bước bàn giao tiếp theo không hợp lệ.');
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new ApiError(400, 'STAGE_RESULT_INVALID', 'Kết quả bước chấm không hợp lệ.');
    }
    const resultJson = JSON.stringify(result);
    if (!resultJson || resultJson.length > 500000) {
      throw new ApiError(400, 'STAGE_RESULT_TOO_LARGE', 'Kết quả bước chấm vượt giới hạn.');
    }
    const resultSha = sha256(resultJson);
    const resultCiphertext = seal(resultJson, key);
    return withTransaction(pool, async client => {
      const pairResult = await client.query(`
        SELECT pair_id, submission_revision, status, homework_file_id
          FROM writing_flow.pair WHERE pair_id=$1 FOR UPDATE`, [pairId]);
      if (pairResult.rowCount !== 1) throw new ApiError(404, 'PAIR_NOT_FOUND', 'Không tìm thấy bài chấm.');
      const pair = pairResult.rows[0];
      if (pair.submission_revision !== revision) {
        throw new ApiError(409, 'PAIR_REVISION_CHANGED', 'Bài đã có phiên bản khác.');
      }
      const stageResult = await client.query(`
        SELECT status,cycle_no,selected_attempt_no
          FROM writing_flow.stage_result
         WHERE pair_id=$1 AND stage_key=$2 FOR UPDATE`, [pairId, stageKey]);
      const attemptResult = await client.query(`
        SELECT attempt_id,cycle_no,attempt_no,status
          FROM writing_flow.stage_attempt
         WHERE attempt_id=$1 AND pair_id=$2 AND stage_key=$3 FOR UPDATE`,
      [attemptId, pairId, stageKey]);
      if (stageResult.rowCount !== 1 || attemptResult.rowCount !== 1) {
        throw new ApiError(409, 'STAGE_ATTEMPT_MISMATCH', 'Lượt chấm không khớp cặp bài.');
      }
      const stage = stageResult.rows[0];
      const attempt = attemptResult.rows[0];
      if (stage.status === 'succeeded' && stage.selected_attempt_no === attempt.attempt_no
        && stage.cycle_no === attempt.cycle_no) {
        return { status: 'already_finished', pairId, stageKey };
      }
      if (pair.status === 'superseded' || stage.cycle_no !== attempt.cycle_no
        || stage.status === 'succeeded' || pair.status === 'delivered') {
        await client.query(`UPDATE writing_flow.stage_attempt
          SET status='late',result_sha256=$2,result_ciphertext=$3,finished_at=now()
          WHERE attempt_id=$1`, [attemptId, resultSha, resultCiphertext]);
        return { status: 'late', pairId, stageKey };
      }
      if (stageKey === 'deliver'
        && (result.readbackOk !== true || result.homeworkFileId !== pair.homework_file_id
          || typeof result.resultUrl !== 'string' || !result.resultUrl.startsWith('https://'))) {
        throw new ApiError(409, 'DELIVERY_READBACK_MISSING', 'Chưa xác nhận link trong đúng homework.');
      }
      await client.query(`UPDATE writing_flow.stage_attempt
        SET status='succeeded',result_sha256=$2,result_ciphertext=$3,finished_at=now()
        WHERE attempt_id=$1`, [attemptId, resultSha, resultCiphertext]);
      await client.query(`UPDATE writing_flow.stage_result
        SET status='succeeded',result_sha256=$3,result_ciphertext=$4,
            selected_attempt_no=$5,completed_at=now(),lease_expires_at=NULL,
            error_code=NULL,updated_at=now()
        WHERE pair_id=$1 AND stage_key=$2`,
      [pairId, stageKey, resultSha, resultCiphertext, attempt.attempt_no]);
      await client.query(`UPDATE writing_flow.manual_review
        SET status='resolved',resolved_at=now()
        WHERE pair_id=$1 AND stage_key=$2 AND status<>'resolved'`, [pairId, stageKey]);
      await client.query(`UPDATE writing_flow.handoff
        SET status='acknowledged',acknowledged_at=now()
        WHERE pair_id=$1 AND from_stage='review' AND to_stage=$2
          AND status IN ('pending','sent')`, [pairId, stageKey]);
      if (stageKey === 'critic' && nextStage === 'render') {
        await client.query(`INSERT INTO writing_flow.stage_result
          (pair_id,stage_key,status,input_sha256)
          VALUES ($1,'arbiter','skipped',$2)
          ON CONFLICT (pair_id,stage_key) DO NOTHING`, [pairId, resultSha]);
      }
      await client.query(`UPDATE writing_flow.pair
        SET status=$2,updated_at=now() WHERE pair_id=$1`,
      [pairId, stageKey === 'deliver' ? 'delivered' : 'running']);
      let handoffId = null;
      if (nextStage) {
        const handoff = await client.query(`
          INSERT INTO writing_flow.handoff
            (pair_id,from_stage,to_stage,source_result_sha256,next_send_at)
          VALUES ($1,$2,$3,$4,now())
          RETURNING handoff_id`, [pairId, stageKey, nextStage, resultSha]);
        handoffId = handoff.rows[0].handoff_id;
      }
      return { status: stageKey === 'deliver' ? 'delivered' : 'succeeded',
        pairId, stageKey, handoffId, nextStage, resultSha256: resultSha };
    });
  }

  // Một bước lỗi được gửi lại ngay; đúng lượt thứ ba mới mở mục Cần kiểm tra.
  async function fail({ pairId, revision, stageKey, attemptId, errorCode, unknown = false }) {
    if (!STAGES.includes(stageKey)) throw new ApiError(400, 'STAGE_INVALID', 'Bước chấm không hợp lệ.');
    return withTransaction(pool, async client => {
      const pairResult = await client.query(`SELECT submission_revision,status
        FROM writing_flow.pair WHERE pair_id=$1 FOR UPDATE`, [pairId]);
      if (pairResult.rowCount !== 1) throw new ApiError(404, 'PAIR_NOT_FOUND', 'Không tìm thấy bài chấm.');
      const pair = pairResult.rows[0];
      if (pair.submission_revision !== revision) {
        throw new ApiError(409, 'PAIR_REVISION_CHANGED', 'Bài đã có phiên bản khác.');
      }
      const stageResult = await client.query(`SELECT status,cycle_no,attempt_count
        FROM writing_flow.stage_result
        WHERE pair_id=$1 AND stage_key=$2 FOR UPDATE`, [pairId, stageKey]);
      const attemptResult = await client.query(`SELECT cycle_no,attempt_no,status
        FROM writing_flow.stage_attempt
        WHERE attempt_id=$1 AND pair_id=$2 AND stage_key=$3 FOR UPDATE`,
      [attemptId, pairId, stageKey]);
      if (stageResult.rowCount !== 1 || attemptResult.rowCount !== 1) {
        throw new ApiError(409, 'STAGE_ATTEMPT_MISMATCH', 'Lượt chấm không khớp cặp bài.');
      }
      const stage = stageResult.rows[0];
      const attempt = attemptResult.rows[0];
      if (attempt.status !== 'sent') return { status: 'already_recorded', pairId, stageKey };
      const stale = pair.status === 'superseded' || pair.status === 'delivered'
        || stage.status === 'succeeded' || stage.cycle_no !== attempt.cycle_no;
      await client.query(`UPDATE writing_flow.stage_attempt
        SET status=$2,error_code=$3,finished_at=now() WHERE attempt_id=$1`,
      [attemptId, stale ? 'late' : unknown ? 'unknown' : 'failed', errorCode]);
      if (stale) return { status: 'late', pairId, stageKey };
      if (stage.attempt_count < 3) {
        await client.query(`UPDATE writing_flow.stage_result
          SET status='pending',error_code=$3,lease_expires_at=NULL,updated_at=now()
          WHERE pair_id=$1 AND stage_key=$2`, [pairId, stageKey, errorCode]);
        const handoff = await client.query(`INSERT INTO writing_flow.handoff
          (pair_id,from_stage,to_stage,source_result_sha256,next_send_at)
          VALUES ($1,'retry',$2,$3,now()) RETURNING handoff_id`,
        [pairId, stageKey, sha256(attemptId)]);
        return { status: 'retry_requested', pairId, stageKey,
          handoffId: handoff.rows[0].handoff_id };
      }
      await client.query(`UPDATE writing_flow.stage_result
        SET status='needs_review',error_code=$3,lease_expires_at=NULL,updated_at=now()
        WHERE pair_id=$1 AND stage_key=$2`, [pairId, stageKey, errorCode]);
      await client.query(`UPDATE writing_flow.pair SET status='needs_review',updated_at=now()
        WHERE pair_id=$1`, [pairId]);
      await client.query(`UPDATE writing_flow.manual_review
        SET status='resolved',resolved_at=now()
        WHERE pair_id=$1 AND stage_key=$2 AND status<>'resolved'`, [pairId, stageKey]);
      await client.query(`INSERT INTO writing_flow.manual_review
        (pair_id,stage_key,cycle_no,error_code)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (pair_id,stage_key,cycle_no)
        DO UPDATE SET error_code=EXCLUDED.error_code`,
      [pairId, stageKey, stage.cycle_no, errorCode]);
      return { status: 'needs_review', pairId, stageKey };
    });
  }

  return { claim, complete, fail };
}
