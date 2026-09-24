import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { keyFromHex, open, seal, sha256 } from './writing-flow-crypto.js';
import { TEST_TASK_DEFINITIONS } from './writing-flow-test.js';

// Nhận vào: một cặp Test, phiên bản bài, lượt chấm chính và mã thành phần.
// Việc chính: khóa đúng cặp, lưu riêng từng lượt AI và chỉ mở cổng khi đủ kết quả.
// Trả ra: những thành phần còn phải chạy hoặc thành quả đã lưu để tiếp tục sau lỗi.
// Khi lỗi: transaction hoàn tác; không ghi bài viết hay kết quả AI vào log thường.
function expected(taskNumber, phase) {
  const criteria = TEST_TASK_DEFINITIONS[Number(taskNumber)]?.criteria;
  if (!criteria || !['detail', 'criterion'].includes(phase)) {
    throw new ApiError(400, 'TEST_COMPONENT_PHASE_INVALID', 'Loại bài hoặc bước thành phần không hợp lệ.');
  }
  return Object.entries(criteria).flatMap(([criterionCode, codes]) =>
    phase === 'detail'
      ? codes.map(componentCode => ({ componentCode, criterionCode }))
      : [{ componentCode: `aggregate_${criterionCode}`, criterionCode }]);
}

function decode(ciphertext, key) {
  return JSON.parse(open(ciphertext, key));
}

async function context(client, { pairId, revision, stageAttemptId }) {
  const found = await client.query(`SELECT p.pair_id,p.submission_revision,p.status AS pair_status,
      p.source_type,tp.task_number,s.status AS stage_status,s.input_sha256,
      s.cycle_no,s.attempt_count,s.error_code AS stage_error_code,
      a.status AS attempt_status,a.error_code AS attempt_error_code,
      a.cycle_no AS attempt_cycle,a.attempt_no
    FROM writing_flow.pair AS p
    JOIN writing_flow.test_pair AS tp ON tp.pair_id=p.pair_id
    JOIN writing_flow.stage_result AS s ON s.pair_id=p.pair_id AND s.stage_key='main'
    JOIN writing_flow.stage_attempt AS a ON a.pair_id=p.pair_id
      AND a.stage_key='main' AND a.attempt_id=$3
    WHERE p.pair_id=$1 AND p.submission_revision=$2
    FOR UPDATE OF p,s,a`, [pairId, revision, stageAttemptId]);
  if (found.rowCount !== 1) {
    throw new ApiError(409, 'TEST_COMPONENT_IDENTITY_MISMATCH',
      'Lượt chấm không khớp bài Test và phiên bản.');
  }
  const row = found.rows[0];
  if (row.source_type !== 'term_test' || !/^[0-9a-f]{64}$/u.test(row.input_sha256 || '')) {
    throw new ApiError(409, 'TEST_COMPONENT_SOURCE_INVALID', 'Nguồn bài Test không hợp lệ.');
  }
  return { ...row, current: row.pair_status === 'running'
    && row.stage_status === 'running' && row.attempt_status === 'sent'
    && Number(row.cycle_no) === Number(row.attempt_cycle)
    && Number(row.attempt_count) === Number(row.attempt_no) };
}

function assertCurrent(row) {
  if (!row.current) throw new ApiError(409, 'TEST_COMPONENT_ATTEMPT_LATE',
    'Lượt chấm này đã hết hiệu lực.');
}

// Retry do quản trị viên yêu cầu chỉ mở lại các thành phần hết ba lượt.
// Các kết quả đã thành công và lịch sử lượt lỗi vẫn được giữ nguyên.
export async function resetFailedTestComponentsForRetry(client, { pairId, inputSha256 }) {
  const reset = await client.query(`UPDATE writing_flow.test_component_work
    SET status='pending',retry_cycle=retry_cycle+1,attempt_count=0,
      selected_attempt_id=NULL,lease_expires_at=NULL,updated_at=now()
    WHERE pair_id=$1 AND input_sha256=$2 AND status='needs_review'
    RETURNING component_code`, [pairId, inputSha256]);
  return reset.rows.map(row => row.component_code);
}

export async function requireCompletedTestComponents(client, { pairId, inputSha256 }) {
  const gate = await client.query(`SELECT
    EXISTS (SELECT 1 FROM writing_flow.test_component_work
      WHERE pair_id=$1 AND input_sha256=$2) AS started,
    EXISTS (SELECT 1 FROM writing_flow.test_component_gate
      WHERE pair_id=$1 AND input_sha256=$2
        AND gate_name='criterion_complete') AS complete`,
  [pairId, inputSha256]);
  if (gate.rows[0]?.started && !gate.rows[0]?.complete) {
    throw new ApiError(409, 'TEST_COMPONENTS_INCOMPLETE',
      'Chưa đủ kết quả từng khía cạnh và bốn tiêu chí Test.');
  }
}

export function createWritingTestComponentService({ pool, encryptionKey }) {
  const key = keyFromHex(encryptionKey);
  function requireKey() {
    if (!key) throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY',
      'Chưa cấu hình nơi lưu kết quả thành phần.');
  }

  async function startPhase({ pairId, revision, stageAttemptId, phase,
    componentCode = null, contractHashes }) {
    requireKey();
    return withTransaction(pool, async client => {
      const owner = await context(client, { pairId, revision, stageAttemptId });
      assertCurrent(owner);
      const definitions = expected(owner.task_number, phase);
      const requested = componentCode
        ? definitions.filter(item => item.componentCode === componentCode)
        : definitions;
      if (requested.length === 0) throw new ApiError(400, 'TEST_COMPONENT_CODE_MISMATCH',
        'Thành phần không thuộc Task và bước này.');
      for (const item of requested) {
        if (!/^[0-9a-f]{64}$/u.test(String(contractHashes?.[item.componentCode] || ''))) {
          throw new ApiError(400, 'TEST_COMPONENT_CONTRACT_MISSING',
            'Thiếu dấu phiên bản của workflow chuyên môn.');
        }
      }
      const inputSha256 = owner.input_sha256;
      if (phase === 'criterion') {
        const gate = await client.query(`SELECT 1 FROM writing_flow.test_component_gate
          WHERE pair_id=$1 AND input_sha256=$2 AND gate_name='detail_complete'
          FOR UPDATE`, [pairId, inputSha256]);
        if (gate.rowCount !== 1) throw new ApiError(409, 'TEST_COMPONENT_DETAIL_INCOMPLETE',
          'Chưa đủ kết quả thành phần để tổng hợp tiêu chí.');
      }
      const jobs = [];
      const completed = [];
      const needsReview = [];
      for (const { componentCode, criterionCode } of requested) {
        const contractSha256 = contractHashes[componentCode];
        await client.query(`INSERT INTO writing_flow.test_component_work
          (pair_id,input_sha256,component_code,contract_sha256,phase,criterion_code)
          VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
        [pairId, inputSha256, componentCode, contractSha256, phase, criterionCode]);
        const selected = await client.query(`SELECT status,contract_sha256,retry_cycle,attempt_count,
            selected_attempt_id,result_ciphertext
          FROM writing_flow.test_component_work
          WHERE pair_id=$1 AND input_sha256=$2 AND component_code=$3 FOR UPDATE`,
        [pairId, inputSha256, componentCode]);
        const work = selected.rows[0];
        if (work.contract_sha256 !== contractSha256) {
          throw new ApiError(409, 'TEST_COMPONENT_CONTRACT_CHANGED',
            'Workflow chuyên môn đã đổi phiên bản; cần đối chiếu trước khi tái dùng kết quả cũ.');
        }
        if (work.status === 'succeeded') {
          completed.push({ componentCode, criterionCode,
            result: decode(work.result_ciphertext, key) });
          continue;
        }
        if (Number(work.attempt_count) >= 3) {
          needsReview.push(componentCode);
          continue;
        }
        if (work.status === 'running' && work.selected_attempt_id) {
          const active = await client.query(`SELECT run_key,stage_attempt_id,status
            FROM writing_flow.test_component_attempt WHERE attempt_id=$1 FOR UPDATE`,
          [work.selected_attempt_id]);
          if (active.rows[0]?.stage_attempt_id === stageAttemptId
            && active.rows[0]?.status === 'sent') {
            jobs.push({ componentCode, criterionCode, runKey: active.rows[0].run_key,
              inputSha256, contractSha256, alreadyStarted: true });
            continue;
          }
          await client.query(`UPDATE writing_flow.test_component_attempt
            SET status='unknown',error_code='STAGE_ATTEMPT_REPLACED',finished_at=now()
            WHERE attempt_id=$1 AND status='sent'`, [work.selected_attempt_id]);
        }
        const nextAttempt = Number(work.attempt_count) + 1;
        const created = await client.query(`INSERT INTO writing_flow.test_component_attempt
          (pair_id,input_sha256,component_code,stage_attempt_id,retry_cycle,attempt_no)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING attempt_id,run_key`,
        [pairId, inputSha256, componentCode, stageAttemptId,
          Number(work.retry_cycle), nextAttempt]);
        await client.query(`UPDATE writing_flow.test_component_work
          SET status='running',attempt_count=$4,selected_attempt_id=$5,
            lease_expires_at=now()+interval '30 minutes',updated_at=now()
          WHERE pair_id=$1 AND input_sha256=$2 AND component_code=$3`,
        [pairId, inputSha256, componentCode, nextAttempt, created.rows[0].attempt_id]);
        jobs.push({ componentCode, criterionCode, runKey: created.rows[0].run_key,
          inputSha256, contractSha256, alreadyStarted: false });
      }
      if (needsReview.length) throw new ApiError(409, 'TEST_COMPONENT_RETRY_EXHAUSTED',
        'Có thành phần đã hết ba lần thử; cần kiểm tra trước khi tiếp tục.');
      const count = await client.query(`SELECT count(*)::integer AS done
        FROM writing_flow.test_component_work
        WHERE pair_id=$1 AND input_sha256=$2 AND phase=$3 AND status='succeeded'
          AND component_code = ANY($4::text[])`,
      [pairId, inputSha256, phase, definitions.map(item => item.componentCode)]);
      if (Number(count.rows[0]?.done) === definitions.length) {
        await client.query(`INSERT INTO writing_flow.test_component_gate
          (pair_id,input_sha256,gate_name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
        [pairId, inputSha256, phase === 'detail' ? 'detail_complete' : 'criterion_complete']);
      }
      return { status: jobs.length ? 'running' : 'complete', pairId, phase,
        inputSha256, jobs, completed,
        completedCount: Number(count.rows[0]?.done), expectedCount: definitions.length };
    });
  }

  async function complete({ pairId, revision, stageAttemptId, componentCode,
    inputSha256, runKey, result }) {
    requireKey();
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new ApiError(400, 'TEST_COMPONENT_RESULT_INVALID', 'Kết quả thành phần không hợp lệ.');
    }
    const json = JSON.stringify(result);
    if (!json || json.length > 180_000) {
      throw new ApiError(400, 'TEST_COMPONENT_RESULT_TOO_LARGE', 'Kết quả thành phần vượt giới hạn.');
    }
    const digest = sha256(json);
    const ciphertext = seal(json, key);
    return withTransaction(pool, async client => {
      const owner = await context(client, { pairId, revision, stageAttemptId });
      if (owner.input_sha256 !== inputSha256) {
        throw new ApiError(409, 'TEST_COMPONENT_INPUT_CHANGED', 'Dấu đầu vào bài Test đã thay đổi.');
      }
      const current = await client.query(`SELECT phase,criterion_code,status,selected_attempt_id,
          contract_sha256,result_sha256 FROM writing_flow.test_component_work
        WHERE pair_id=$1 AND input_sha256=$2 AND component_code=$3 FOR UPDATE`,
      [pairId, inputSha256, componentCode]);
      const attempt = await client.query(`SELECT attempt_id,status,result_sha256
        FROM writing_flow.test_component_attempt
        WHERE pair_id=$1 AND input_sha256=$2 AND component_code=$3
          AND stage_attempt_id=$4 AND run_key=$5 FOR UPDATE`,
      [pairId, inputSha256, componentCode, stageAttemptId, runKey]);
      if (current.rowCount !== 1 || attempt.rowCount !== 1) {
        throw new ApiError(409, 'TEST_COMPONENT_RUN_KEY_MISMATCH', 'Lượt thành phần không khớp.');
      }
      const work = current.rows[0];
      const run = attempt.rows[0];
      if (String(result.sourceHash || '') !== work.contract_sha256) {
        throw new ApiError(409, 'TEST_COMPONENT_CONTRACT_CHANGED',
          'Kết quả không thuộc phiên bản workflow chuyên môn đã được cấp.');
      }
      if (!expected(owner.task_number, work.phase).some(item =>
        item.componentCode === componentCode && item.criterionCode === work.criterion_code)) {
        throw new ApiError(409, 'TEST_COMPONENT_CODE_MISMATCH', 'Thành phần không thuộc Task này.');
      }
      if (work.status === 'succeeded' && work.selected_attempt_id === run.attempt_id
        && run.status === 'succeeded') {
        if (work.result_sha256 !== digest || run.result_sha256 !== digest) {
          throw new ApiError(409, 'TEST_COMPONENT_DUPLICATE_CONFLICT',
            'Cùng lượt thành phần trả hai kết quả khác nhau.');
        }
        return { status: 'already_accepted', pairId, componentCode };
      }
      // Khi một khía cạnh đã lỗi ba lần, các khía cạnh khác cùng lượt vẫn có thể
      // trả kết quả đã tốn AI; giữ chúng để lần Retry chỉ chấm phần thiếu.
      const draining = owner.pair_status === 'needs_review'
        && owner.stage_status === 'needs_review'
        && owner.stage_error_code === 'TEST_COMPONENT_RETRY_EXHAUSTED'
        && owner.attempt_status === 'failed'
        && owner.attempt_error_code === 'TEST_COMPONENT_RETRY_EXHAUSTED';
      if ((!owner.current && !draining) || work.status !== 'running'
        || work.selected_attempt_id !== run.attempt_id || run.status !== 'sent') {
        await client.query(`UPDATE writing_flow.test_component_attempt
          SET status='late',finished_at=now() WHERE attempt_id=$1 AND status='sent'`,
        [run.attempt_id]);
        return { status: 'late', pairId, componentCode };
      }
      await client.query(`UPDATE writing_flow.test_component_attempt
        SET status='succeeded',result_sha256=$2,result_ciphertext=$3,finished_at=now()
        WHERE attempt_id=$1`, [run.attempt_id, digest, ciphertext]);
      await client.query(`UPDATE writing_flow.test_component_work
        SET status='succeeded',result_sha256=$4,result_ciphertext=$5,
          completed_at=now(),lease_expires_at=NULL,updated_at=now()
        WHERE pair_id=$1 AND input_sha256=$2 AND component_code=$3`,
      [pairId, inputSha256, componentCode, digest, ciphertext]);
      const definitions = expected(owner.task_number, work.phase);
      const count = await client.query(`SELECT count(*)::integer AS done
        FROM writing_flow.test_component_work
        WHERE pair_id=$1 AND input_sha256=$2 AND phase=$3 AND status='succeeded'
          AND component_code = ANY($4::text[])`,
      [pairId, inputSha256, work.phase, definitions.map(item => item.componentCode)]);
      const allComplete = Number(count.rows[0]?.done) === definitions.length;
      let gateCreated = false;
      if (allComplete) {
        const gate = await client.query(`INSERT INTO writing_flow.test_component_gate
          (pair_id,input_sha256,gate_name) VALUES ($1,$2,$3)
          ON CONFLICT DO NOTHING RETURNING gate_name`,
        [pairId, inputSha256,
          work.phase === 'detail' ? 'detail_complete' : 'criterion_complete']);
        gateCreated = gate.rowCount === 1;
      }
      return { status: 'accepted', pairId, componentCode, phase: work.phase,
        completedCount: Number(count.rows[0]?.done), expectedCount: definitions.length,
        allComplete, gateCreated };
    });
  }

  async function fail({ pairId, revision, stageAttemptId, componentCode,
    inputSha256, runKey, errorCode }) {
    requireKey();
    if (!/^[A-Z][A-Z0-9_]{2,99}$/u.test(String(errorCode || ''))) {
      throw new ApiError(400, 'TEST_COMPONENT_ERROR_INVALID', 'Mã lỗi thành phần không hợp lệ.');
    }
    return withTransaction(pool, async client => {
      const owner = await context(client, { pairId, revision, stageAttemptId });
      if (owner.input_sha256 !== inputSha256) {
        throw new ApiError(409, 'TEST_COMPONENT_INPUT_CHANGED', 'Dấu đầu vào bài Test đã thay đổi.');
      }
      const work = await client.query(`SELECT phase,criterion_code,status,attempt_count,selected_attempt_id
        FROM writing_flow.test_component_work
        WHERE pair_id=$1 AND input_sha256=$2 AND component_code=$3 FOR UPDATE`,
      [pairId, inputSha256, componentCode]);
      const attempt = await client.query(`SELECT attempt_id,status
        FROM writing_flow.test_component_attempt
        WHERE pair_id=$1 AND input_sha256=$2 AND component_code=$3
          AND stage_attempt_id=$4 AND run_key=$5 FOR UPDATE`,
      [pairId, inputSha256, componentCode, stageAttemptId, runKey]);
      if (work.rowCount !== 1 || attempt.rowCount !== 1) {
        throw new ApiError(409, 'TEST_COMPONENT_RUN_KEY_MISMATCH', 'Lượt thành phần không khớp.');
      }
      const selected = work.rows[0];
      const run = attempt.rows[0];
      if (!expected(owner.task_number, selected.phase).some(item =>
        item.componentCode === componentCode && item.criterionCode === selected.criterion_code)) {
        throw new ApiError(409, 'TEST_COMPONENT_CODE_MISMATCH', 'Thành phần không thuộc Task này.');
      }
      if (!owner.current || selected.selected_attempt_id !== run.attempt_id
        || selected.status !== 'running' || run.status !== 'sent') {
        return { status: 'late', pairId, componentCode };
      }
      await client.query(`UPDATE writing_flow.test_component_attempt
        SET status='failed',error_code=$2,finished_at=now() WHERE attempt_id=$1`,
      [run.attempt_id, errorCode]);
      const exhausted = Number(selected.attempt_count) >= 3;
      await client.query(`UPDATE writing_flow.test_component_work
        SET status=$4,selected_attempt_id=NULL,lease_expires_at=NULL,updated_at=now()
        WHERE pair_id=$1 AND input_sha256=$2 AND component_code=$3`,
      [pairId, inputSha256, componentCode, exhausted ? 'needs_review' : 'pending']);
      if (exhausted) {
        await client.query(`UPDATE writing_flow.stage_attempt
          SET status='failed',error_code='TEST_COMPONENT_RETRY_EXHAUSTED',finished_at=now()
          WHERE attempt_id=$1 AND status='sent'`, [stageAttemptId]);
        await client.query(`UPDATE writing_flow.stage_result
          SET status='needs_review',error_code='TEST_COMPONENT_RETRY_EXHAUSTED',
            lease_expires_at=NULL,updated_at=now()
          WHERE pair_id=$1 AND stage_key='main'`, [pairId]);
        await client.query(`UPDATE writing_flow.pair
          SET status='needs_review',updated_at=now() WHERE pair_id=$1`, [pairId]);
        await client.query(`INSERT INTO writing_flow.manual_review
          (pair_id,stage_key,cycle_no,error_code)
          VALUES ($1,'main',$2,'TEST_COMPONENT_RETRY_EXHAUSTED')
          ON CONFLICT (pair_id,stage_key,cycle_no)
          DO UPDATE SET error_code=EXCLUDED.error_code`,
        [pairId, Number(owner.cycle_no)]);
      }
      return { status: exhausted ? 'needs_review' : 'retry_ready',
        pairId, componentCode, attemptCount: Number(selected.attempt_count) };
    });
  }

  return { startPhase, complete, fail };
}
