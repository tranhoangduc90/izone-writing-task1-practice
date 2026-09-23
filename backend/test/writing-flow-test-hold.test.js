import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowStage } from '../src/writing-flow-stage.js';
import { createWritingFlowHandoff } from '../src/writing-flow-handoff.js';
import { writingFlowWorkStatusSql } from '../src/writing-flow-notifier.js';
import { keyFromHex, seal } from '../src/writing-flow-crypto.js';

test('Test hợp lệ được nhận ở bước chấm cũ và vẫn giữ đúng một lượt thử', async () => {
  const pairId = '11111111-1111-4111-8111-111111111111';
  const handoffId = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const encryptionKey = '11'.repeat(32);
  const sourceCiphertext = seal(JSON.stringify(['task_2', 'Đề giả', '',
    'Bài giả đủ nội dung để thử đường đi.', true]), keyFromHex(encryptionKey));
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('SELECT pair_id, submission_revision')) return {
        rowCount: 1, rows: [{ pair_id: pairId, submission_revision: 'revision-demo',
          status: 'running', source_type: 'term_test', source_ciphertext: sourceCiphertext,
          source_app_id: 'manual_dashboard', source_table_id: 'manual:demo',
          source_record_id: 'demo', homework_file_id: 'doc-demo', source_link_index: 1,
          essay_slot: 1, class_code: 'MANUAL', document_kind: 'google_docs',
          source_modified_at: new Date('2026-09-24T00:00:00Z') }],
      };
      if (sql.includes('SELECT handoff_id, from_stage')) return {
        rowCount: 1, rows: [{ handoff_id: handoffId, from_stage: 'precheck',
          to_stage: 'main', source_result_sha256: 'a'.repeat(64), status: 'pending' }],
      };
      if (sql.includes('SELECT pair_id, stage_key, status')) return {
        rowCount: 1, rows: [{ pair_id: pairId, stage_key: 'main',
          status: 'pending', cycle_no: 1, attempt_count: 0,
          input_sha256: 'a'.repeat(64) }],
      };
      if (sql.includes('INSERT INTO writing_flow.stage_attempt')) return {
        rowCount: 1, rows: [{ attempt_id: '33333333-3333-4333-8333-333333333333' }],
      };
      if (sql.includes('SELECT stage_key,result_ciphertext')) return {
        rowCount: 0, rows: [],
      };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const result = await createWritingFlowStage({
    pool: { connect: async () => client }, encryptionKey,
  }).claim({ pairId, revision: 'revision-demo', stageKey: 'main',
    handoffId, executionId: 'hold-test' });
  assert.equal(result.status, 'started');
  assert.equal(result.source.sourceType, 'term_test');
  assert.equal(result.attemptNo, 1);
  assert.equal(calls.filter(sql => sql.includes('INSERT INTO writing_flow.stage_attempt')).length, 1);
  assert.equal(calls.some(sql => sql.includes("SET status='acknowledged'")), true);
});

test('bộ gửi lại và bộ đánh thức nhận Test ở bước chấm chính', async () => {
  const statements = [];
  const client = {
    async query(sql) {
      statements.push(sql);
      return { rowCount: 0, rows: [] };
    },
    release() {},
  };
  const handoffs = await createWritingFlowHandoff({
    pool: { connect: async () => client },
  }).due(20);
  assert.deepEqual(handoffs, []);
  assert.equal(statements.some(sql => sql.includes("p.source_type='term_test' AND h.to_stage='main'")), false);
  assert.equal(writingFlowWorkStatusSql.includes("p.source_type='term_test' AND h.to_stage='main'"), false);
});

test('Test đã giao không được nhận lượt chấm lại dù có bàn giao cũ', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('SELECT pair_id, submission_revision')) return {
        rowCount: 1, rows: [{ pair_id: 'pair-demo', submission_revision: 'rev-demo',
          status: 'delivered', source_type: 'term_test' }],
      };
      if (sql.includes('SELECT handoff_id, from_stage')) return {
        rowCount: 1, rows: [{ handoff_id: 'handoff-demo', from_stage: 'precheck',
          to_stage: 'main', status: 'pending', source_result_sha256: 'a'.repeat(64) }],
      };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const result = await createWritingFlowStage({
    pool: { connect: async () => client }, encryptionKey: '11'.repeat(32),
  }).claim({ pairId: 'pair-demo', revision: 'rev-demo', stageKey: 'main',
    handoffId: 'handoff-demo', executionId: 'replay-demo' });
  assert.equal(result.status, 'already_delivered');
  assert.equal(calls.some(sql => sql.includes('INSERT INTO writing_flow.stage_attempt')), false);
});
