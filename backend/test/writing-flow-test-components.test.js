import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createWritingTestComponentService,
  resetFailedTestComponentsForRetry,
  requireCompletedTestComponents } from '../src/writing-flow-test-components.js';
import { TEST_TASK_DEFINITIONS } from '../src/writing-flow-test.js';

const PAIR = '11111111-1111-4111-8111-111111111111';
const SECOND_PAIR = '22222222-2222-4222-8222-222222222222';
const STAGE_ATTEMPT = '33333333-3333-4333-8333-333333333333';
const NEXT_STAGE_ATTEMPT = '44444444-4444-4444-8444-444444444444';
const RETRY_STAGE_ATTEMPT = '55555555-5555-4555-8555-555555555555';
const INPUT_SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);
const CONTRACT_SHA = 'd'.repeat(64);

async function setup() {
  const db = new PGlite();
  await db.exec(`CREATE ROLE writing_practice_api;
    CREATE SCHEMA writing_flow;
    CREATE TABLE writing_flow.pair (
      pair_id uuid PRIMARY KEY,submission_revision text NOT NULL,
      status text NOT NULL,source_type text NOT NULL,updated_at timestamptz);
    CREATE TABLE writing_flow.stage_result (
      pair_id uuid NOT NULL,stage_key text NOT NULL,status text NOT NULL,
      input_sha256 char(64),cycle_no integer NOT NULL,attempt_count smallint NOT NULL,
      error_code text,lease_expires_at timestamptz,updated_at timestamptz,
      PRIMARY KEY(pair_id,stage_key));
    CREATE TABLE writing_flow.stage_attempt (
      attempt_id uuid PRIMARY KEY,pair_id uuid NOT NULL,stage_key text NOT NULL,
      status text NOT NULL,cycle_no integer NOT NULL,attempt_no smallint NOT NULL,
      error_code text,finished_at timestamptz);
    CREATE TABLE writing_flow.test_pair (pair_id uuid PRIMARY KEY,task_number smallint NOT NULL);
    CREATE TABLE writing_flow.manual_review (
      pair_id uuid NOT NULL,stage_key text NOT NULL,cycle_no integer NOT NULL,
      error_code text NOT NULL,PRIMARY KEY(pair_id,stage_key,cycle_no));
  `);
  const migration = await readFile(new URL(
    '../../docs/migrations/2026-09-24-writing-flow-test-component-callback-v16.sql',
    import.meta.url), 'utf8');
  await db.exec(migration);
  await db.exec(migration);
  await db.query(`INSERT INTO writing_flow.pair
    (pair_id,submission_revision,status,source_type) VALUES
    ($1,'rev-one','running','term_test'),
    ($2,'rev-one','running','term_test')`, [PAIR, SECOND_PAIR]);
  await db.query(`INSERT INTO writing_flow.test_pair VALUES ($1,2),($2,1)`,
    [PAIR, SECOND_PAIR]);
  await db.query(`INSERT INTO writing_flow.stage_result
    (pair_id,stage_key,status,input_sha256,cycle_no,attempt_count) VALUES
    ($1,'main','running',$3,1,1),($2,'main','running',$3,1,1)`,
  [PAIR, SECOND_PAIR, INPUT_SHA]);
  await db.query(`INSERT INTO writing_flow.stage_attempt
    (attempt_id,pair_id,stage_key,status,cycle_no,attempt_no) VALUES
    ($1,$3,'main','sent',1,1),($2,$4,'main','sent',1,1)`,
  [STAGE_ATTEMPT, NEXT_STAGE_ATTEMPT, PAIR, SECOND_PAIR]);
  const ready = await db.query(`SELECT p.pair_id FROM writing_flow.pair AS p
    JOIN writing_flow.test_pair AS tp ON tp.pair_id=p.pair_id
    JOIN writing_flow.stage_result AS s ON s.pair_id=p.pair_id AND s.stage_key='main'
    JOIN writing_flow.stage_attempt AS a ON a.pair_id=p.pair_id
      AND a.stage_key='main' AND a.attempt_id=$1
    WHERE p.pair_id=$2 AND p.submission_revision='rev-one'`, [STAGE_ATTEMPT, PAIR]);
  assert.equal(ready.rows.length, 1);
  const pool = {
    connect: async () => ({
      query: async (...args) => {
        const result = await db.query(...args);
        return { ...result, rowCount: result.rows.length };
      },
      release() {},
    }),
  };
  const rawService = createWritingTestComponentService({
    pool, encryptionKey: '11'.repeat(32),
  });
  const service = { ...rawService, startPhase: input => {
    const taskNumber = input.pairId === SECOND_PAIR ? 1 : 2;
    const codes = input.phase === 'detail'
      ? Object.values(TEST_TASK_DEFINITIONS[taskNumber].criteria).flat()
      : Object.keys(TEST_TASK_DEFINITIONS[taskNumber].criteria)
        .map(code => `aggregate_${code}`);
    return rawService.startPhase({ ...input,
      contractHashes: Object.fromEntries(codes.map(code => [code, CONTRACT_SHA])) });
  } };
  return { db, pool, service, rawService };
}

function request(job, pairId = PAIR, stageAttemptId = STAGE_ATTEMPT) {
  return { pairId, revision: 'rev-one', stageAttemptId,
    componentCode: job.componentCode, inputSha256: job.inputSha256,
    runKey: job.runKey, result: { sourceHash: job.contractSha256,
      feedback: `Nhận xét giả cho ${job.componentCode}` } };
}

test('Task 2 nhận 10 thành phần đảo thứ tự, chặn tổng hợp sớm và chỉ mở một cổng', async () => {
  const { db, pool, service } = await setup();
  try {
    const client = await pool.connect();
    await requireCompletedTestComponents(client, { pairId: PAIR, inputSha256: INPUT_SHA });
    const start = await service.startPhase({ pairId: PAIR,
      revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT, phase: 'detail' });
    assert.equal(start.jobs.length, 10);
    assert.equal(new Set(start.jobs.map(job => job.runKey)).size, 10);
    await assert.rejects(requireCompletedTestComponents(client, {
      pairId: PAIR, inputSha256: INPUT_SHA }),
    error => error.code === 'TEST_COMPONENTS_INCOMPLETE');
    await assert.rejects(service.startPhase({ pairId: PAIR,
      revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT, phase: 'criterion' }),
    error => error.code === 'TEST_COMPONENT_DETAIL_INCOMPLETE');
    const order = [...start.jobs].reverse();
    for (const [index, job] of order.entries()) {
      const result = await service.complete(request(job));
      assert.equal(result.completedCount, index + 1);
      assert.equal(result.allComplete, index === 9);
      assert.equal(result.gateCreated, index === 9);
    }
    const duplicate = await service.complete(request(order[0]));
    assert.equal(duplicate.status, 'already_accepted');
    await assert.rejects(service.complete({ ...request(order[0]),
      result: { sourceHash: order[0].contractSha256, feedback: 'khác' } }),
      error => error.code === 'TEST_COMPONENT_DUPLICATE_CONFLICT');
    const replay = await service.startPhase({ pairId: PAIR,
      revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT, phase: 'detail' });
    assert.equal(replay.status, 'complete');
    assert.equal(replay.completed.length, 10);
    await assert.rejects(requireCompletedTestComponents(client, {
      pairId: PAIR, inputSha256: INPUT_SHA }),
    error => error.code === 'TEST_COMPONENTS_INCOMPLETE');
    const criteria = await service.startPhase({ pairId: PAIR,
      revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT, phase: 'criterion' });
    assert.equal(criteria.jobs.length, 4);
    for (const [index, job] of [...criteria.jobs].reverse().entries()) {
      const result = await service.complete(request(job));
      assert.equal(result.gateCreated, index === 3);
    }
    const gates = await db.query(`SELECT gate_name FROM writing_flow.test_component_gate
      WHERE pair_id=$1 ORDER BY gate_name`, [PAIR]);
    assert.deepEqual(gates.rows.map(row => row.gate_name),
      ['criterion_complete', 'detail_complete']);
    await requireCompletedTestComponents(client, { pairId: PAIR, inputSha256: INPUT_SHA });
  } finally { await db.close(); }
});

test('sai bài, phiên bản, dấu đầu vào hoặc run key dừng trước khi ghi kết quả', async () => {
  const { db, service, rawService } = await setup();
  try {
    const first = await service.startPhase({ pairId: PAIR,
      revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT, phase: 'detail' });
    const job = first.jobs[0];
    const invalid = [
      { ...request(job), pairId: SECOND_PAIR },
      { ...request(job), revision: 'rev-other' },
      { ...request(job), inputSha256: OTHER_SHA },
      { ...request(job), runKey: NEXT_STAGE_ATTEMPT },
      { ...request(job), result: { sourceHash: 'e'.repeat(64) } },
    ];
    for (const item of invalid) await assert.rejects(service.complete(item));
    await assert.rejects(rawService.startPhase({ pairId: PAIR,
      revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT,
      phase: 'detail', componentCode: job.componentCode,
      contractHashes: { [job.componentCode]: 'e'.repeat(64) } }),
    error => error.code === 'TEST_COMPONENT_CONTRACT_CHANGED');
    const stored = await db.query(`SELECT count(*)::integer AS n
      FROM writing_flow.test_component_work WHERE pair_id=$1 AND status='succeeded'`, [PAIR]);
    assert.equal(stored.rows[0].n, 0);
    const valid = await service.complete(request(job));
    assert.equal(valid.status, 'accepted');
  } finally { await db.close(); }
});

test('lượt cũ đến muộn không ghi đè; Task 1 giữ tám phần đã xong khi retry', async () => {
  const { db, service } = await setup();
  try {
    const first = await service.startPhase({ pairId: SECOND_PAIR,
      revision: 'rev-one', stageAttemptId: NEXT_STAGE_ATTEMPT, phase: 'detail' });
    assert.equal(first.jobs.length, 9);
    for (const job of first.jobs.slice(0, 8)) {
      await service.complete(request(job, SECOND_PAIR, NEXT_STAGE_ATTEMPT));
    }
    await db.query(`UPDATE writing_flow.stage_attempt SET status='unknown'
      WHERE attempt_id=$1`, [NEXT_STAGE_ATTEMPT]);
    await db.query(`INSERT INTO writing_flow.stage_attempt
      (attempt_id,pair_id,stage_key,status,cycle_no,attempt_no) VALUES
      ($1,$2,'main','sent',1,2)`, [RETRY_STAGE_ATTEMPT, SECOND_PAIR]);
    await db.query(`UPDATE writing_flow.stage_result SET attempt_count=2
      WHERE pair_id=$1 AND stage_key='main'`, [SECOND_PAIR]);
    const resumed = await service.startPhase({ pairId: SECOND_PAIR,
      revision: 'rev-one', stageAttemptId: RETRY_STAGE_ATTEMPT, phase: 'detail' });
    assert.equal(resumed.completed.length, 8);
    assert.equal(resumed.jobs.length, 1);
    const late = await service.complete(request(first.jobs[8], SECOND_PAIR, NEXT_STAGE_ATTEMPT));
    assert.equal(late.status, 'late');
    const good = await service.complete(request(resumed.jobs[0], SECOND_PAIR, RETRY_STAGE_ATTEMPT));
    assert.equal(good.allComplete, true);
    const attempts = await db.query(`SELECT count(*)::integer AS n
      FROM writing_flow.test_component_attempt
      WHERE pair_id=$1 AND component_code=$2`,
    [SECOND_PAIR, first.jobs[8].componentCode]);
    assert.equal(attempts.rows[0].n, 2);
  } finally { await db.close(); }
});

test('ba lỗi của một thành phần dừng đúng phần đó để kiểm tra', async () => {
  const { db, service } = await setup();
  try {
    const started = await service.startPhase({ pairId: PAIR,
      revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT, phase: 'detail' });
    let current = started.jobs[0];
    for (let index = 1; index <= 3; index++) {
      const failed = await service.fail({ ...request(current), errorCode: 'AI_REQUEST_FAILED' });
      assert.equal(failed.attemptCount, index);
      assert.equal(failed.status, index === 3 ? 'needs_review' : 'retry_ready');
      if (index < 3) {
        const restarted = await service.startPhase({ pairId: PAIR,
          revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT, phase: 'detail' });
        current = restarted.jobs.find(job => job.componentCode === current.componentCode);
      }
    }
    await assert.rejects(service.startPhase({ pairId: PAIR,
      revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT, phase: 'detail' }),
    error => error.code === 'TEST_COMPONENT_ATTEMPT_LATE');
    const gate = await db.query(`SELECT count(*)::integer AS n
      FROM writing_flow.test_component_gate WHERE pair_id=$1`, [PAIR]);
    assert.equal(gate.rows[0].n, 0);
    const pair = await db.query(`SELECT status FROM writing_flow.pair WHERE pair_id=$1`, [PAIR]);
    assert.equal(pair.rows[0].status, 'needs_review');
    const stage = await db.query(`SELECT status,error_code FROM writing_flow.stage_result
      WHERE pair_id=$1 AND stage_key='main'`, [PAIR]);
    assert.deepEqual(stage.rows[0], { status: 'needs_review',
      error_code: 'TEST_COMPONENT_RETRY_EXHAUSTED' });
    const reviews = await db.query(`SELECT count(*)::integer AS n
      FROM writing_flow.manual_review WHERE pair_id=$1`, [PAIR]);
    assert.equal(reviews.rows[0].n, 1);
    const finishingPeer = await service.complete(request(started.jobs[1]));
    assert.equal(finishingPeer.status, 'accepted');
    assert.equal(finishingPeer.allComplete, false);
  } finally { await db.close(); }
});

test('bản ghi thành phần lạ không thể mở cổng tổng hợp trước thành phần cuối', async () => {
  const { db, service } = await setup();
  try {
    const started = await service.startPhase({ pairId: PAIR,
      revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT, phase: 'detail' });
    await db.query(`INSERT INTO writing_flow.test_component_work
      (pair_id,input_sha256,component_code,contract_sha256,phase,criterion_code)
      VALUES ($1,$2,'rogue_component',$3,'detail','TR')`,
    [PAIR, INPUT_SHA, CONTRACT_SHA]);
    const rogueAttempt = '66666666-6666-4666-8666-666666666666';
    await db.query(`INSERT INTO writing_flow.test_component_attempt
      (attempt_id,pair_id,input_sha256,component_code,stage_attempt_id,retry_cycle,attempt_no)
      VALUES ($1,$2,$3,'rogue_component',$4,1,1)`,
    [rogueAttempt, PAIR, INPUT_SHA, STAGE_ATTEMPT]);
    await db.query(`UPDATE writing_flow.test_component_work
      SET status='succeeded',selected_attempt_id=$3,result_sha256=$4,
        result_ciphertext=decode('00','hex'),completed_at=now()
      WHERE pair_id=$1 AND input_sha256=$2 AND component_code='rogue_component'`,
    [PAIR, INPUT_SHA, rogueAttempt, 'c'.repeat(64)]);
    for (const job of started.jobs.slice(0, 9)) {
      const accepted = await service.complete(request(job));
      assert.equal(accepted.allComplete, false);
      assert.equal(accepted.gateCreated, false);
    }
    const gates = await db.query(`SELECT count(*)::integer AS n
      FROM writing_flow.test_component_gate WHERE pair_id=$1`, [PAIR]);
    assert.equal(gates.rows[0].n, 0);
    const final = await service.complete(request(started.jobs[9]));
    assert.equal(final.gateCreated, true);
  } finally { await db.close(); }
});

test('Retry thủ công giữ thành phần đã xong và mở chu kỳ riêng cho phần lỗi', async () => {
  const { db, pool, service } = await setup();
  try {
    const started = await service.startPhase({ pairId: PAIR,
      revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT, phase: 'detail' });
    await service.complete(request(started.jobs[1]));
    let failedJob = started.jobs[0];
    for (let index = 0; index < 3; index++) {
      await service.fail({ ...request(failedJob), errorCode: 'AI_FAILED' });
      if (index < 2) {
        const pending = await service.startPhase({ pairId: PAIR,
          revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT, phase: 'detail' });
        failedJob = pending.jobs.find(job => job.componentCode === failedJob.componentCode);
      }
    }
    const client = await pool.connect();
    try {
      const reset = await resetFailedTestComponentsForRetry(client, {
        pairId: PAIR, inputSha256: INPUT_SHA });
      assert.deepEqual(reset, [failedJob.componentCode]);
    } finally { client.release(); }
    const manualAttempt = '77777777-7777-4777-8777-777777777777';
    await db.query(`UPDATE writing_flow.pair SET status='running' WHERE pair_id=$1`, [PAIR]);
    await db.query(`UPDATE writing_flow.stage_result
      SET status='running',cycle_no=2,attempt_count=1
      WHERE pair_id=$1 AND stage_key='main'`, [PAIR]);
    await db.query(`INSERT INTO writing_flow.stage_attempt
      (attempt_id,pair_id,stage_key,status,cycle_no,attempt_no)
      VALUES ($1,$2,'main','sent',2,1)`, [manualAttempt, PAIR]);
    const resumed = await service.startPhase({ pairId: PAIR,
      revision: 'rev-one', stageAttemptId: manualAttempt, phase: 'detail' });
    assert.equal(resumed.completed.length, 1);
    assert.equal(resumed.completed[0].componentCode, started.jobs[1].componentCode);
    assert.equal(resumed.jobs.length, 9);
    const refreshed = resumed.jobs.find(job => job.componentCode === failedJob.componentCode);
    const history = await db.query(`SELECT retry_cycle,attempt_no
      FROM writing_flow.test_component_attempt
      WHERE pair_id=$1 AND component_code=$2 ORDER BY retry_cycle,attempt_no`,
    [PAIR, failedJob.componentCode]);
    assert.deepEqual(history.rows.map(row => [row.retry_cycle, row.attempt_no]),
      [[1, 1], [1, 2], [1, 3], [2, 1]]);
    assert.equal((await service.complete(request(refreshed, PAIR, manualAttempt))).status,
      'accepted');
  } finally { await db.close(); }
});

test('cấp từng phần đúng lúc, không tính ba lượt cho phần chưa hề gọi AI', async () => {
  const { db, service } = await setup();
  try {
    const codes = Object.values(TEST_TASK_DEFINITIONS[2].criteria).flat();
    for (const [index, componentCode] of codes.entries()) {
      const phase = await service.startPhase({ pairId: PAIR,
        revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT,
        phase: 'detail', componentCode });
      assert.equal(phase.jobs.length, 1);
      assert.equal(phase.completedCount, index);
      const attempts = await db.query(`SELECT count(*)::integer AS n
        FROM writing_flow.test_component_attempt WHERE pair_id=$1`, [PAIR]);
      assert.equal(attempts.rows[0].n, index + 1);
      const complete = await service.complete(request(phase.jobs[0]));
      assert.equal(complete.gateCreated, index === codes.length - 1);
    }
    await assert.rejects(service.startPhase({ pairId: PAIR,
      revision: 'rev-one', stageAttemptId: STAGE_ATTEMPT,
      phase: 'detail', componentCode: 'unknown_component' }),
    error => error.code === 'TEST_COMPONENT_CODE_MISMATCH');
  } finally { await db.close(); }
});
