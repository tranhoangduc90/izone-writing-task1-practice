import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { keyFromHex, open, seal, sha256 } from './writing-flow-crypto.js';

const LEASE_SECONDS = 600;

function decode(value, key) {
  return JSON.parse(open(value, key));
}

function operationKey(pairId, cycleNo) {
  return `writing:trcc-repair:${pairId}:${cycleNo}`;
}

// Nhận vào: các cặp Classroom từng bị lưu nhầm cờ không kiểm TR/CC.
// Việc chính: lập hàng đợi sửa có khóa, ba lần thử và nhật ký riêng; phần chấm câu cũ được giữ nguyên.
// Kết quả: mỗi bài chỉ gọi bổ sung TR/CC rồi yêu cầu tạo lại trang và ghi lại link.
// Khi lỗi: bài dừng ở hàng đợi sửa, không sửa trực tiếp kết quả cũ hoặc ghi sang Lark Base.
export function createWritingFlowTrccRepair({ pool, encryptionKey }) {
  const key = keyFromHex(encryptionKey);

  async function seed({ batchRequestId, limit = 5000, actorRef = 'trcc_incident_repair' }) {
    if (!key) throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY', 'Chưa cấu hình nơi lưu bài chấm.');
    return withTransaction(pool, async client => {
      const candidates = await client.query(`
        SELECT p.pair_id,p.source_ciphertext,p.status,p.submission_revision,
               pre.result_ciphertext AS precheck_result
          FROM writing_flow.pair AS p
          JOIN writing_flow.stage_result AS pre
            ON pre.pair_id=p.pair_id AND pre.stage_key='precheck' AND pre.status='succeeded'
          JOIN writing_flow.stage_result AS render
            ON render.pair_id=p.pair_id AND render.stage_key='render' AND render.status='succeeded'
         WHERE p.source_type='google_classroom'
           AND p.status IN ('delivered','needs_review')
           AND p.skipped_at IS NULL
           AND COALESCE(p.trcc_required_override,false)=false
         ORDER BY p.created_at,p.pair_id
         LIMIT $1 FOR UPDATE OF p SKIP LOCKED`, [limit]);
      let seeded = 0;
      for (const row of candidates.rows) {
        const source = decode(row.source_ciphertext, key);
        const precheck = decode(row.precheck_result, key);
        if (source[4] !== false || String(precheck?.tr_cc ?? '').trim()) continue;
        const inserted = await client.query(`
          INSERT INTO writing_flow.trcc_repair (pair_id,status,batch_request_id)
          VALUES ($1,'pending',$2)
          ON CONFLICT (pair_id) DO NOTHING
          RETURNING pair_id`, [row.pair_id, batchRequestId]);
        if (!inserted.rowCount) continue;
        await client.query(`UPDATE writing_flow.pair
          SET trcc_required_override=true,updated_at=now() WHERE pair_id=$1`, [row.pair_id]);
        const sourceHash = sha256(`trcc-repair:${row.pair_id}:1`);
        await client.query(`INSERT INTO writing_flow.handoff
          (pair_id,from_stage,to_stage,source_result_sha256,status,next_send_at)
          VALUES ($1,'incident','trcc_repair',$2,'pending',now())
          ON CONFLICT (pair_id,from_stage,to_stage,source_result_sha256) DO NOTHING`,
        [row.pair_id, sourceHash]);
        await client.query(`INSERT INTO writing_flow.operator_event
          (pair_id,event_type,actor_ref,request_id,reason,before_state,after_state)
          VALUES ($1,'trcc_repair_seeded',$2,$3,'Bổ sung TR/CC bị thiếu do lỗi luồng nguồn',
                  jsonb_build_object('pairStatus',$4::text,'trCcCheck',false),
                  jsonb_build_object('repairStatus','pending','batchRequestId',$5::text))`,
        [row.pair_id, actorRef, crypto.randomUUID(), row.status, batchRequestId]);
        seeded += 1;
      }
      return { batchRequestId, candidateCount: candidates.rowCount, seededCount: seeded };
    });
  }

  async function claim({ pairId, revision, handoffId, executionId }) {
    if (!key) throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY', 'Chưa cấu hình nơi lưu bài chấm.');
    return withTransaction(pool, async client => {
      const pairResult = await client.query(`
        SELECT pair_id,submission_revision,status,source_ciphertext,skipped_at
          FROM writing_flow.pair WHERE pair_id=$1 FOR UPDATE`, [pairId]);
      if (pairResult.rowCount !== 1) throw new ApiError(404, 'PAIR_NOT_FOUND', 'Không tìm thấy bài chấm.');
      const pair = pairResult.rows[0];
      if (pair.submission_revision !== revision) {
        throw new ApiError(409, 'PAIR_REVISION_CHANGED', 'Bài đã có phiên bản khác.');
      }
      if (pair.skipped_at) throw new ApiError(409, 'PAIR_SKIPPED', 'Bài đang được bỏ qua.');
      const handoffResult = await client.query(`SELECT handoff_id,to_stage,status
        FROM writing_flow.handoff WHERE handoff_id=$1 AND pair_id=$2 FOR UPDATE`,
      [handoffId, pairId]);
      if (handoffResult.rowCount !== 1 || handoffResult.rows[0].to_stage !== 'trcc_repair') {
        throw new ApiError(409, 'HANDOFF_MISMATCH', 'Yêu cầu cứu TR/CC không khớp bài.');
      }
      if (!['pending','sent'].includes(handoffResult.rows[0].status)) {
        return { status: 'superseded', pairId, stageKey: 'trcc_repair' };
      }
      if (pair.status === 'superseded') {
        await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',acknowledged_at=now()
          WHERE handoff_id=$1`, [handoffId]);
        return { status: 'superseded', pairId, stageKey: 'trcc_repair' };
      }
      const repairResult = await client.query(`SELECT pair_id,status,cycle_no,attempt_count,
          lease_expires_at,result_ciphertext,error_code
        FROM writing_flow.trcc_repair WHERE pair_id=$1 FOR UPDATE`, [pairId]);
      if (repairResult.rowCount !== 1) throw new ApiError(409, 'TRCC_REPAIR_NOT_READY', 'Bài chưa nằm trong hàng đợi cứu TR/CC.');
      let repair = repairResult.rows[0];
      if (repair.status === 'succeeded') {
        await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',acknowledged_at=now()
          WHERE handoff_id=$1`, [handoffId]);
        return { status: 'already_finished', pairId, stageKey: 'trcc_repair' };
      }
      if (repair.status === 'needs_review') {
        await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',acknowledged_at=now()
          WHERE handoff_id=$1`, [handoffId]);
        return { status: 'needs_review', pairId, stageKey: 'trcc_repair' };
      }
      if (repair.status === 'running' && repair.lease_expires_at
        && new Date(repair.lease_expires_at).getTime() > Date.now()) {
        return { status: 'already_running', pairId, stageKey: 'trcc_repair' };
      }
      if (repair.status === 'running') {
        await client.query(`UPDATE writing_flow.trcc_repair_attempt
          SET status='unknown',error_code='TRCC_REPAIR_TIMEOUT',finished_at=now()
          WHERE pair_id=$1 AND cycle_no=$2 AND attempt_no=$3 AND status='sent'`,
        [pairId, repair.cycle_no, repair.attempt_count]);
      }
      if (repair.attempt_count >= 3) {
        await client.query(`UPDATE writing_flow.trcc_repair
          SET status='needs_review',error_code='TRCC_REPAIR_TIMEOUT',lease_expires_at=NULL,updated_at=now()
          WHERE pair_id=$1`, [pairId]);
        await client.query(`UPDATE writing_flow.pair SET status='needs_review',updated_at=now()
          WHERE pair_id=$1`, [pairId]);
        return { status: 'needs_review', pairId, stageKey: 'trcc_repair' };
      }
      const attemptNo = Number(repair.attempt_count) + 1;
      const attempt = await client.query(`INSERT INTO writing_flow.trcc_repair_attempt
        (pair_id,cycle_no,attempt_no,request_key,status,n8n_execution_id)
        VALUES ($1,$2,$3,$4,'sent',$5) RETURNING repair_attempt_id`,
      [pairId, repair.cycle_no, attemptNo, crypto.randomUUID(), executionId]);
      await client.query(`UPDATE writing_flow.trcc_repair
        SET status='running',attempt_count=$2,started_at=now(),
            lease_expires_at=now()+($3::integer*interval '1 second'),updated_at=now()
        WHERE pair_id=$1`, [pairId, attemptNo, LEASE_SECONDS]);
      await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',acknowledged_at=now()
        WHERE handoff_id=$1`, [handoffId]);
      const precheckResult = await client.query(`SELECT result_ciphertext
        FROM writing_flow.stage_result
        WHERE pair_id=$1 AND stage_key='precheck' AND status='succeeded'`, [pairId]);
      if (precheckResult.rowCount !== 1) {
        throw new ApiError(409, 'TRCC_REPAIR_PRECHECK_MISSING', 'Thiếu dữ liệu đã kiểm của bài.');
      }
      const source = decode(pair.source_ciphertext, key);
      const precheck = decode(precheckResult.rows[0].result_ciphertext, key);
      const opKey = operationKey(pairId, repair.cycle_no);
      return { status: 'started', pairId, revision, stageKey: 'trcc_repair',
        repairAttemptId: attempt.rows[0].repair_attempt_id,
        attemptNo, cycleNo: repair.cycle_no, operationKey: opKey,
        source: { taskType: source[0], deBai: precheck.de_bai || source[1],
          baiLam: precheck.bai_lam || source[3], lesson: precheck.lesson } };
    });
  }

  async function complete({ pairId, revision, repairAttemptId, operationKey: receivedKey, result }) {
    if (!key) throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY', 'Chưa cấu hình nơi lưu bài chấm.');
    const text = String(result?.text ?? '').trim();
    if (!text) throw new ApiError(400, 'TRCC_REPAIR_RESULT_EMPTY', 'Kết quả TR/CC trống.');
    const resultJson = JSON.stringify(result);
    if (resultJson.length > 100000) throw new ApiError(400, 'TRCC_REPAIR_RESULT_TOO_LARGE', 'Kết quả TR/CC quá dài.');
    return withTransaction(pool, async client => {
      const pairResult = await client.query(`SELECT submission_revision,status
        FROM writing_flow.pair WHERE pair_id=$1 FOR UPDATE`, [pairId]);
      if (pairResult.rowCount !== 1) throw new ApiError(404, 'PAIR_NOT_FOUND', 'Không tìm thấy bài chấm.');
      if (pairResult.rows[0].submission_revision !== revision) {
        throw new ApiError(409, 'PAIR_REVISION_CHANGED', 'Bài đã có phiên bản khác.');
      }
      const repairResult = await client.query(`SELECT status,cycle_no,attempt_count
        FROM writing_flow.trcc_repair WHERE pair_id=$1 FOR UPDATE`, [pairId]);
      const attemptResult = await client.query(`SELECT cycle_no,attempt_no,status
        FROM writing_flow.trcc_repair_attempt
        WHERE repair_attempt_id=$1 AND pair_id=$2 FOR UPDATE`, [repairAttemptId, pairId]);
      if (repairResult.rowCount !== 1 || attemptResult.rowCount !== 1) {
        throw new ApiError(409, 'TRCC_REPAIR_ATTEMPT_MISMATCH', 'Lượt cứu TR/CC không khớp bài.');
      }
      const repair = repairResult.rows[0];
      const attempt = attemptResult.rows[0];
      if (repair.status === 'succeeded') return { status: 'already_finished', pairId };
      if (repair.cycle_no !== attempt.cycle_no || repair.attempt_count !== attempt.attempt_no
        || attempt.status !== 'sent') {
        throw new ApiError(409, 'TRCC_REPAIR_ATTEMPT_MISMATCH', 'Lượt cứu TR/CC không còn hiệu lực.');
      }
      const expectedKey = operationKey(pairId, repair.cycle_no);
      if (receivedKey !== expectedKey) {
        throw new ApiError(409, 'TRCC_REPAIR_OPERATION_KEY_MISMATCH', 'Mã gọi TR/CC không khớp.');
      }
      const resultSha = sha256(resultJson);
      const resultCiphertext = seal(resultJson, key);
      await client.query(`UPDATE writing_flow.trcc_repair_attempt
        SET status='succeeded',result_sha256=$2,result_ciphertext=$3,finished_at=now()
        WHERE repair_attempt_id=$1`, [repairAttemptId, resultSha, resultCiphertext]);
      await client.query(`UPDATE writing_flow.trcc_repair
        SET status='succeeded',result_sha256=$2,result_ciphertext=$3,
            completed_at=now(),lease_expires_at=NULL,error_code=NULL,updated_at=now()
        WHERE pair_id=$1`, [pairId, resultSha, resultCiphertext]);
      const stages = await client.query(`SELECT stage_key,status,cycle_no
        FROM writing_flow.stage_result WHERE pair_id=$1 AND stage_key IN ('render','deliver')
        FOR UPDATE`, [pairId]);
      if (!stages.rows.some(row => row.stage_key === 'render')) {
        throw new ApiError(409, 'TRCC_REPAIR_RENDER_MISSING', 'Bài chưa có bước tạo trang để phát hành lại.');
      }
      await client.query(`UPDATE writing_flow.stage_result
        SET status='pending',cycle_no=cycle_no+1,attempt_count=0,result_sha256=NULL,
            result_ciphertext=NULL,selected_attempt_no=NULL,
            error_code=CASE WHEN stage_key='render' THEN NULL ELSE 'UPSTREAM_RETRY_REQUESTED' END,
            n8n_execution_id=NULL,started_at=NULL,lease_expires_at=NULL,
            completed_at=NULL,updated_at=now()
        WHERE pair_id=$1 AND stage_key IN ('render','deliver')`, [pairId]);
      await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',acknowledged_at=now(),
        error_code='SUPERSEDED_BY_TRCC_REPAIR'
        WHERE pair_id=$1 AND status IN ('pending','sent','needs_review')`, [pairId]);
      const commandHash = sha256(`trcc-repair-complete:${pairId}:${repair.cycle_no}:${resultSha}`);
      const handoff = await client.query(`INSERT INTO writing_flow.handoff
        (pair_id,from_stage,to_stage,source_result_sha256,status,next_send_at)
        VALUES ($1,'retry','render',$2,'pending',now()) RETURNING handoff_id`,
      [pairId, commandHash]);
      await client.query(`UPDATE writing_flow.pair
        SET status='running',finished_at=NULL,updated_at=now() WHERE pair_id=$1`, [pairId]);
      await client.query(`INSERT INTO writing_flow.operator_event
        (pair_id,event_type,actor_ref,request_id,reason,before_state,after_state)
        VALUES ($1,'trcc_repair_completed','trcc_incident_repair',$2,
                'Đã bổ sung TR/CC; tạo lại trang và ghi lại link',
                jsonb_build_object('repairStatus','running'),
                jsonb_build_object('repairStatus','succeeded','renderHandoffId',$3::text))`,
      [pairId, crypto.randomUUID(), handoff.rows[0].handoff_id]);
      return { status: 'succeeded', pairId, handoffId: handoff.rows[0].handoff_id,
        nextStage: 'render' };
    });
  }

  async function fail({ pairId, revision, repairAttemptId, errorCode, unknown = false }) {
    return withTransaction(pool, async client => {
      const pairResult = await client.query(`SELECT submission_revision,status
        FROM writing_flow.pair WHERE pair_id=$1 FOR UPDATE`, [pairId]);
      if (pairResult.rowCount !== 1) throw new ApiError(404, 'PAIR_NOT_FOUND', 'Không tìm thấy bài chấm.');
      if (pairResult.rows[0].submission_revision !== revision) {
        throw new ApiError(409, 'PAIR_REVISION_CHANGED', 'Bài đã có phiên bản khác.');
      }
      const repairResult = await client.query(`SELECT status,cycle_no,attempt_count
        FROM writing_flow.trcc_repair WHERE pair_id=$1 FOR UPDATE`, [pairId]);
      const attemptResult = await client.query(`SELECT cycle_no,attempt_no,status
        FROM writing_flow.trcc_repair_attempt
        WHERE repair_attempt_id=$1 AND pair_id=$2 FOR UPDATE`, [repairAttemptId, pairId]);
      if (repairResult.rowCount !== 1 || attemptResult.rowCount !== 1) {
        throw new ApiError(409, 'TRCC_REPAIR_ATTEMPT_MISMATCH', 'Lượt cứu TR/CC không khớp bài.');
      }
      const repair = repairResult.rows[0];
      const attempt = attemptResult.rows[0];
      if (attempt.status !== 'sent') return { status: 'already_recorded', pairId };
      const stale = repair.status === 'succeeded' || repair.cycle_no !== attempt.cycle_no;
      await client.query(`UPDATE writing_flow.trcc_repair_attempt
        SET status=$2,error_code=$3,finished_at=now() WHERE repair_attempt_id=$1`,
      [repairAttemptId, stale ? 'late' : unknown ? 'unknown' : 'failed', errorCode]);
      if (stale) return { status: 'late', pairId };
      if (repair.attempt_count < 3) {
        await client.query(`UPDATE writing_flow.trcc_repair
          SET status='pending',error_code=$2,lease_expires_at=NULL,updated_at=now()
          WHERE pair_id=$1`, [pairId, errorCode]);
        const sourceHash = sha256(`trcc-repair-retry:${repairAttemptId}`);
        const handoff = await client.query(`INSERT INTO writing_flow.handoff
          (pair_id,from_stage,to_stage,source_result_sha256,status,next_send_at)
          VALUES ($1,'retry','trcc_repair',$2,'pending',now()) RETURNING handoff_id`,
        [pairId, sourceHash]);
        return { status: 'retry_requested', pairId, handoffId: handoff.rows[0].handoff_id,
          retryImmediately: true };
      }
      await client.query(`UPDATE writing_flow.trcc_repair
        SET status='needs_review',error_code=$2,lease_expires_at=NULL,updated_at=now()
        WHERE pair_id=$1`, [pairId, errorCode]);
      await client.query(`UPDATE writing_flow.pair SET status='needs_review',updated_at=now()
        WHERE pair_id=$1`, [pairId]);
      await client.query(`INSERT INTO writing_flow.operator_event
        (pair_id,event_type,actor_ref,request_id,reason,before_state,after_state)
        VALUES ($1,'trcc_repair_failed','trcc_incident_repair',$2,$3,
                jsonb_build_object('attemptCount',$4),
                jsonb_build_object('repairStatus','needs_review','errorCode',$3))`,
      [pairId, crypto.randomUUID(), errorCode, repair.attempt_count]);
      return { status: 'needs_review', pairId };
    });
  }

  async function summary() {
    const result = await pool.query(`SELECT status,count(*)::integer AS count
      FROM writing_flow.trcc_repair GROUP BY status ORDER BY status`);
    return Object.fromEntries(result.rows.map(row => [row.status, row.count]));
  }

  async function recoverExpired(limit = 20) {
    const expired = await pool.query(`SELECT r.pair_id,p.submission_revision,
        a.repair_attempt_id
      FROM writing_flow.trcc_repair AS r
      JOIN writing_flow.pair AS p ON p.pair_id=r.pair_id
      JOIN writing_flow.trcc_repair_attempt AS a
        ON a.pair_id=r.pair_id AND a.cycle_no=r.cycle_no
       AND a.attempt_no=r.attempt_count AND a.status='sent'
      WHERE r.status='running' AND r.lease_expires_at<=now()
      ORDER BY r.lease_expires_at,r.pair_id LIMIT $1`, [limit]);
    const recovered = [];
    for (const row of expired.rows) {
      try {
        recovered.push(await fail({ pairId: row.pair_id,
          revision: row.submission_revision, repairAttemptId: row.repair_attempt_id,
          errorCode: 'TRCC_REPAIR_TIMEOUT', unknown: true }));
      } catch (error) {
        if (error?.code !== 'TRCC_REPAIR_ATTEMPT_MISMATCH') throw error;
      }
    }
    return recovered;
  }

  return { seed, claim, complete, fail, summary, recoverExpired };
}
