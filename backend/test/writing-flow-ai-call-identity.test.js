// Nhận vào: yêu cầu gọi AI của một cặp và một nhóm câu giả.
// Việc chính: xác nhận biên nhận database mang lại đầy đủ mã cặp, bước, lượt và nhóm.
// Trả ra: phép thử đạt; lỗi định danh hiện rõ trước khi workflow ghép kết quả.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowAiCall } from '../src/writing-flow-ai-call.js';

test('biên nhận lần gọi AI giữ định danh nhóm khi bắt đầu và ghi kết quả', async () => {
  const pairId = '11111111-1111-4111-8111-111111111111';
  const revision = 'a'.repeat(64);
  const attemptId = '22222222-2222-4222-8222-222222222222';
  const batchIndex = 4;
  const operationKey = 'writing:request-demo:4';
  const client = {
    async query(sql) {
      if (sql.includes('SELECT submission_revision,status')) return {
        rowCount: 1, rows: [{ submission_revision: revision, status: 'running' }],
      };
      if (sql.includes('SELECT a.request_key')) return {
        rowCount: 1, rows: [{ request_key: 'request-demo', status: 'sent',
          stage_status: 'running' }],
      };
      if (sql.includes('SELECT call_id,prompt_sha256')) return { rowCount: 0, rows: [] };
      if (sql.includes('SELECT call_id,result_ciphertext')) return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO writing_flow.ai_call')) return {
        rowCount: 1, rows: [{ call_id: '33333333-3333-4333-8333-333333333333' }],
      };
      if (sql.includes('SELECT submission_revision FROM writing_flow.pair')) return {
        rowCount: 1, rows: [{ submission_revision: revision }],
      };
      if (sql.includes('SELECT call_id,status,operation_key')) return {
        rowCount: 1, rows: [{ call_id: '33333333-3333-4333-8333-333333333333',
          status: 'sent', operation_key: operationKey, result_sha256: null }],
      };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const service = createWritingFlowAiCall({
    pool: { connect: async () => client }, encryptionKey: '11'.repeat(32),
  });
  const scope = { pairId, revision, stageKey: 'main', attemptId, batchIndex };
  const started = await service.start({ ...scope, prompt: 'Đề thử không có dữ liệu riêng.' });
  assert.deepEqual({ pairId: started.pairId, revision: started.revision,
    stageKey: started.stageKey, attemptId: started.attemptId,
    batchIndex: started.batchIndex, operationKey: started.operationKey },
  { ...scope, operationKey });
  const finished = await service.finish({ ...scope, operationKey,
    outcome: 'succeeded', result: { items: [] } });
  assert.deepEqual({ pairId: finished.pairId, revision: finished.revision,
    stageKey: finished.stageKey, attemptId: finished.attemptId,
    batchIndex: finished.batchIndex, operationKey: finished.operationKey },
  { ...scope, operationKey });
});
