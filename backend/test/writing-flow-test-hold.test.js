import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowStage } from '../src/writing-flow-stage.js';
import { createWritingFlowHandoff } from '../src/writing-flow-handoff.js';
import { writingFlowWorkStatusSql } from '../src/writing-flow-notifier.js';

test('giữ bài Test trước khi gọi AI, không tiêu lượt thử hay đóng bàn giao', async () => {
  const pairId = '11111111-1111-4111-8111-111111111111';
  const handoffId = '22222222-2222-4222-8222-222222222222';
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql.includes('SELECT pair_id, submission_revision')) return {
        rowCount: 1, rows: [{ pair_id: pairId, submission_revision: 'revision-demo',
          status: 'running', source_type: 'term_test' }],
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
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const result = await createWritingFlowStage({
    pool: { connect: async () => client }, encryptionKey: '11'.repeat(32),
  }).claim({ pairId, revision: 'revision-demo', stageKey: 'main',
    handoffId, executionId: 'hold-test' });
  assert.equal(result.status, 'paused_test_grading');
  assert.equal(calls.some(sql => sql.includes('INSERT INTO writing_flow.stage_attempt')), false);
  assert.equal(calls.some(sql => sql.includes("SET status='acknowledged'")), false);
});

test('bộ gửi lại và bộ đánh thức loại Test ở bước chấm chính khỏi lịch cấp việc', async () => {
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
  assert.equal(statements.some(sql => sql.includes("p.source_type='term_test' AND h.to_stage='main'")), true);
  assert.equal(writingFlowWorkStatusSql.includes("p.source_type='term_test' AND h.to_stage='main'"), true);
});
