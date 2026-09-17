import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowStage } from '../src/writing-flow-stage.js';
import { seal, sha256 } from '../src/writing-flow-crypto.js';

test('bàn giao bước chấm giữ đúng file, link và ô homework', async () => {
  const encryptionKey = '11'.repeat(32);
  const key = Buffer.from(encryptionKey, 'hex');
  const source = ['task_1', 'Đề giả', 'https://example.test/chart', 'Bài giả'];
  const revision = sha256(JSON.stringify(source));
  const pairId = '11111111-1111-4111-8111-111111111111';
  const handoffId = '22222222-2222-4222-8222-222222222222';
  const inputHash = 'a'.repeat(64);
  const client = {
    async query(sql) {
      if (sql.includes('SELECT pair_id, submission_revision')) return {
        rowCount: 1, rows: [{
          pair_id: pairId, submission_revision: revision, status: 'received',
          source_ciphertext: seal(JSON.stringify(source), key),
          source_record_id: 'record-demo', homework_file_id: 'doc-demo',
          source_link_index: 2, essay_slot: 4, class_code: 'IC2200',
          document_kind: 'google_docs', source_modified_at: '2026-09-17T08:00:00Z',
        }],
      };
      if (sql.includes('SELECT handoff_id, from_stage')) return {
        rowCount: 1, rows: [{ handoff_id: handoffId, from_stage: 'intake',
          to_stage: 'precheck', source_result_sha256: inputHash, status: 'pending' }],
      };
      if (sql.includes('SELECT pair_id, stage_key, status')) return {
        rowCount: 1, rows: [{ pair_id: pairId, stage_key: 'precheck',
          status: 'pending', cycle_no: 1, attempt_count: 0, input_sha256: inputHash }],
      };
      if (sql.includes('INSERT INTO writing_flow.stage_attempt')) return {
        rowCount: 1, rows: [{ attempt_id: '33333333-3333-4333-8333-333333333333' }],
      };
      if (sql.includes('SELECT stage_key,result_ciphertext')) return {
        rowCount: 1, rows: [{ stage_key: 'intake',
          result_ciphertext: seal(JSON.stringify({ operationKey: 'scan-demo' }), key) }],
      };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const stage = createWritingFlowStage({
    pool: { connect: async () => client }, encryptionKey,
  });
  const result = await stage.claim({ pairId, revision, stageKey: 'precheck',
    handoffId, executionId: 'execution-demo' });
  assert.equal(result.status, 'started');
  assert.deepEqual(result.source, {
    taskType: 'task_1', topic: 'Đề giả',
    image: 'https://example.test/chart', essay: 'Bài giả',
    recordId: 'record-demo', homeworkFileId: 'doc-demo',
    sourceLinkIndex: 2, essaySlot: 4, classCode: 'IC2200',
    documentKind: 'google_docs',
    sourceModifiedAt: '2026-09-17T08:00:00.000Z',
  });
  assert.deepEqual(result.previous.intake, { operationKey: 'scan-demo' });
});
