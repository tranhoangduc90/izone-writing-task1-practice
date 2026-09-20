import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { createWritingFlowStage } from '../src/writing-flow-stage.js';
import { seal, sha256 } from '../src/writing-flow-crypto.js';

const encryptionKey = '22'.repeat(32);
const key = Buffer.from(encryptionKey, 'hex');
const pairId = '11111111-1111-4111-8111-111111111111';
const handoffId = '22222222-2222-4222-8222-222222222222';
const attemptId = '33333333-3333-4333-8333-333333333333';
const source = ['task_2', 'Đề giả', '', 'Bài giả', false];
const revision = sha256(JSON.stringify(source));

function pairRow(status = 'running', savedRevision = revision) {
  return {
    pair_id: pairId,
    submission_revision: savedRevision,
    status,
    source_ciphertext: seal(JSON.stringify(source), key),
    source_app_id: 'app-demo',
    source_table_id: 'table-demo',
    source_record_id: 'record-demo',
    homework_file_id: 'doc-demo',
    source_link_index: 1,
    essay_slot: 2,
    class_code: 'IC2200',
    document_kind: 'google_docs',
    source_modified_at: '2026-09-17T08:00:00Z',
  };
}

function stageWith(client) {
  return createWritingFlowStage({
    pool: { connect: async () => client },
    encryptionKey,
  });
}

test('lease hết hạn đánh dấu lượt cũ chưa rõ rồi cấp lượt mới cho đúng bài', async () => {
  const queries = [];
  const inputHash = 'a'.repeat(64);
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('SELECT pair_id, submission_revision')) {
        return { rowCount: 1, rows: [pairRow()] };
      }
      if (sql.includes('SELECT handoff_id, from_stage')) {
        return { rowCount: 1, rows: [{
          handoff_id: handoffId,
          from_stage: 'retry',
          to_stage: 'main',
          source_result_sha256: inputHash,
          status: 'pending',
        }] };
      }
      if (sql.includes('SELECT pair_id, stage_key, status')) {
        return { rowCount: 1, rows: [{
          pair_id: pairId,
          stage_key: 'main',
          status: 'running',
          cycle_no: 1,
          attempt_count: 1,
          input_sha256: inputHash,
          lease_expires_at: '2026-09-17T07:00:00Z',
        }] };
      }
      if (sql.includes('INSERT INTO writing_flow.stage_attempt')) {
        return { rowCount: 1, rows: [{ attempt_id: attemptId }] };
      }
      if (sql.includes('SELECT stage_key,result_ciphertext')) {
        return { rowCount: 0, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };

  const result = await stageWith(client).claim({
    pairId,
    revision,
    stageKey: 'main',
    handoffId,
    executionId: 'execution-new',
  });

  assert.equal(result.status, 'started');
  assert.equal(result.attemptNo, 2);
  assert.ok(queries.some(({ sql, params }) =>
    sql.includes("SET status='unknown', error_code='STAGE_TIMEOUT'")
      && params[3] === 1));
  assert.ok(queries.some(({ sql, params }) =>
    sql.includes("SET status='running', attempt_count=$3")
      && params[2] === 2
      && params[3] === 'execution-new'));
});

test('kết quả đến muộn được lưu ở lượt cũ nhưng không ghi đè bước đã thành công', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('SELECT pair_id, submission_revision')) {
        return { rowCount: 1, rows: [pairRow()] };
      }
      if (sql.includes('SELECT status,cycle_no,selected_attempt_no')) {
        return { rowCount: 1, rows: [{
          status: 'succeeded',
          cycle_no: 1,
          selected_attempt_no: 2,
        }] };
      }
      if (sql.includes('SELECT attempt_id,cycle_no,attempt_no,status')) {
        return { rowCount: 1, rows: [{
          attempt_id: attemptId,
          cycle_no: 1,
          attempt_no: 1,
          status: 'sent',
        }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };

  const result = await stageWith(client).complete({
    pairId,
    revision,
    stageKey: 'main',
    attemptId,
    result: { corrections: [{ item: 1 }] },
    nextStage: 'critic',
  });

  assert.equal(result.status, 'late');
  assert.ok(queries.some(({ sql }) => sql.includes("SET status='late'")));
  assert.equal(queries.some(({ sql }) =>
    sql.includes("SET status='succeeded',result_sha256")), false);
  assert.equal(queries.some(({ sql }) =>
    sql.includes('INSERT INTO writing_flow.handoff')), false);
});

test('bài bị sửa giữa luồng dừng trước khi cấp lượt chấm mới', async () => {
  const queries = [];
  const changedRevision = 'b'.repeat(64);
  const client = {
    async query(sql) {
      queries.push(sql);
      if (sql.includes('SELECT pair_id, submission_revision')) {
        return { rowCount: 1, rows: [pairRow('running', changedRevision)] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };

  await assert.rejects(
    stageWith(client).claim({
      pairId,
      revision,
      stageKey: 'main',
      handoffId,
      executionId: 'execution-old-source',
    }),
    error => error?.status === 409 && error?.code === 'PAIR_REVISION_CHANGED',
  );
  assert.equal(queries.some(sql =>
    sql.includes('INSERT INTO writing_flow.stage_attempt')), false);
});

test('biên nhận AI không còn giả đang gửi sau khi lượt xử lý đã thất bại hoặc quá hạn', () => {
  const stageSource = fs.readFileSync(new URL('../src/writing-flow-stage.js', import.meta.url), 'utf8');
  const handoffSource = fs.readFileSync(new URL('../src/writing-flow-handoff.js', import.meta.url), 'utf8');
  assert.match(stageSource,
    /UPDATE writing_flow\.ai_call[\s\S]*WHERE attempt_id=\$1 AND status='sent'/u);
  assert.match(stageSource,
    /UPDATE writing_flow\.ai_call AS c[\s\S]*a\.cycle_no=\$3 AND a\.attempt_no=\$4/u);
  assert.match(handoffSource,
    /UPDATE writing_flow\.ai_call[\s\S]*error_code='STAGE_TIMEOUT'[\s\S]*status='sent'/u);
});
