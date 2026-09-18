import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowScan } from '../src/writing-flow-scan.js';

const key = 'a'.repeat(64);
const request = {
  appId: 'app-demo', tableId: 'table-demo', recordId: 'record-demo',
  docId: 'doc-demo', linkIndex: 2,
  expectedPairs: [{ essaySlot: 1, revision: 'b'.repeat(64) }],
  expectedIssues: [{ essaySlot: 2, reasonCode: 'SOURCE_MISSING' }],
};

test('ghi kế hoạch hai ô trước khi phát, gửi lại cùng kế hoạch không tạo bản khác', async () => {
  let saved = null;
  const client = { async query(sql, args) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
    if (sql.includes('FROM writing_flow.scan_item i JOIN')) {
      return { rowCount: 1, rows: [{ status: 'pending', receipt_plan_sha256: saved,
        source_record_id: request.recordId, homework_file_id: request.docId,
        source_link_index: request.linkIndex, run_status: 'open',
        source_app_id: request.appId, source_table_id: request.tableId }] };
    }
    if (sql.includes('SET receipt_plan=')) { saved = args[3]; return { rowCount: 1 }; }
    throw new Error(`UNEXPECTED_QUERY:${sql}`);
  }, release() {} };
  const service = createWritingFlowScan({ pool: { connect: async () => client } });
  const plan = { runId: 'run-demo', itemKey: key, status: 'partial',
    detectedSlotCount: 2, receiptRequest: request };
  const first = await service.prepare(plan);
  const second = await service.prepare(plan);
  assert.equal(first.status, 'planned');
  assert.equal(first.operationCount, 2);
  assert.equal(first.planSha256, second.planSha256);
  const changed = await service.prepare({ ...plan, receiptRequest: {
    ...request, expectedPairs: [{ essaySlot: 1, revision: 'c'.repeat(64) }] } });
  assert.notEqual(changed.planSha256, first.planSha256);
  assert.equal(saved, changed.planSha256);
  await assert.rejects(service.prepare({ ...plan, status: 'accepted' }),
    { code: 'SCAN_PLAN_COUNT_INVALID' });
  await assert.rejects(service.prepare({ ...plan, receiptRequest: {
    ...request, recordId: 'wrong-record' } }), { code: 'SCAN_PLAN_SCOPE_MISMATCH' });
});

test('lượt kiểm định kỳ chỉ chốt link khi cả hai ô đã có biên nhận thật', async () => {
  const plan = { status: 'partial', detectedSlotCount: 2, receiptRequest: request };
  const pool = { async query(sql) {
    if (sql.includes('i.receipt_plan IS NOT NULL')) {
      return { rows: [{ run_id: 'run-demo', item_key: key,
        receipt_plan: plan, receipt_plan_sha256: 'plan-sha' }] };
    }
    if (sql.includes('FROM writing_flow.scan_run r') && sql.includes('NOT EXISTS')) {
      return { rows: [] };
    }
    throw new Error(`UNEXPECTED_QUERY:${sql}`);
  } };
  const service = createWritingFlowScan({ pool });
  let ready = false;
  const acknowledged = [];
  service.receipts = async () => {
    if (!ready) throw Object.assign(new Error('missing'), { code: 'SCAN_PAIR_RECEIPT_MISSING' });
    return { pairIds: ['pair-1'], issueKeys: ['issue-2'] };
  };
  service.acknowledge = async input => { acknowledged.push(input); };
  await service.finishReady({ limit: 10 });
  assert.equal(acknowledged.length, 0);
  ready = true;
  await service.finishReady({ limit: 10 });
  assert.deepEqual(acknowledged[0], { runId: 'run-demo', itemKey: key,
    status: 'partial', detectedSlotCount: 2,
    expectedPlanSha256: 'plan-sha',
    pairIds: ['pair-1'], issueKeys: ['issue-2'] });
});

test('kế hoạch bị thay trong lúc đối chiếu không chốt biên nhận cũ', async () => {
  const plan = { status: 'partial', detectedSlotCount: 2, receiptRequest: request };
  const pool = { async query(sql) {
    if (sql.includes('i.receipt_plan IS NOT NULL')) return { rows: [{
      run_id: 'run-demo', item_key: key, receipt_plan: plan,
      receipt_plan_sha256: 'old-plan' }] };
    if (sql.includes('FROM writing_flow.scan_run r') && sql.includes('NOT EXISTS')) {
      return { rows: [] };
    }
    throw new Error(`UNEXPECTED_QUERY:${sql}`);
  } };
  const service = createWritingFlowScan({ pool });
  service.receipts = async () => ({ pairIds: ['old-pair'], issueKeys: ['old-issue'] });
  let attempted = 0;
  service.acknowledge = async () => {
    attempted += 1;
    throw Object.assign(new Error('replaced'), { code: 'SCAN_PLAN_REPLACED' });
  };
  assert.deepEqual(await service.finishReady({ limit: 10 }), []);
  assert.equal(attempted, 1);
});

test('database từ chối chốt nếu phiên bản kế hoạch đã đổi dưới khóa', async () => {
  const client = { async query(sql) {
    if (sql === 'BEGIN' || sql === 'ROLLBACK') return {};
    if (sql.includes('FROM writing_flow.scan_item i JOIN')) return { rowCount: 1,
      rows: [{ run_status: 'open', status: 'pending',
        receipt_plan_sha256: 'new-plan' }] };
    throw new Error(`UNEXPECTED_QUERY:${sql}`);
  }, release() {} };
  const service = createWritingFlowScan({ pool: { connect: async () => client } });
  await assert.rejects(service.acknowledge({ runId: 'run-demo', itemKey: key,
    status: 'partial', pairIds: ['pair-demo'], issueKeys: ['issue-demo'],
    detectedSlotCount: 2, expectedPlanSha256: 'old-plan' }),
  { code: 'SCAN_PLAN_REPLACED' });
});
