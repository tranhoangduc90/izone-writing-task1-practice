import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowService } from '../src/writing-flow-service.js';

const reviewId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';

// Cơ sở dữ liệu giả chỉ mô phỏng khóa và transaction để kiểm một lần bấm không phát hai việc.
function fakePool(attemptCount = 3) {
  const state = {
    review_id: reviewId, pair_id: '33333333-3333-4333-8333-333333333333',
    stage_key: 'main', cycle_no: 1, stage_cycle_no: 1,
    status: 'open', stage_status: 'needs_review', pair_status: 'needs_review',
    retry_command_key: null, attempt_count: attemptCount, handoffs: 0,
  };
  const client = {
    async query(sql, values = []) {
      if (sql.includes('SELECT r.review_id')) return { rowCount: 1, rows: [{ ...state }] };
      if (sql.includes('UPDATE writing_flow.manual_review')) {
        state.status = 'retry_requested'; state.retry_command_key = values[2];
      }
      if (sql.includes('INSERT INTO writing_flow.handoff')) state.handoffs += 1;
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  return { state, pool: { connect: async () => client } };
}

test('cùng mã yêu cầu chỉ phát một bàn giao, mã khác bị chặn', async () => {
  const { pool, state } = fakePool();
  const service = createWritingFlowService({ pool });
  const input = { reviewId, requestId, actorRef: 'admin@example.invalid' };
  assert.equal((await service.requestRetry(input)).status, 'retry_requested');
  assert.equal((await service.requestRetry(input)).status, 'retry_requested');
  assert.equal(state.handoffs, 1);
  await assert.rejects(service.requestRetry({ ...input, requestId: '44444444-4444-4444-8444-444444444444' }),
    error => error.code === 'RETRY_ALREADY_REQUESTED');
  assert.equal(state.handoffs, 1);
});

test('chưa đủ ba lượt thì không phát yêu cầu chấm lại từ danh sách kiểm tra', async () => {
  const { pool, state } = fakePool(2);
  const service = createWritingFlowService({ pool });
  await assert.rejects(service.requestRetry({ reviewId, requestId, actorRef: 'admin@example.invalid' }),
    error => error.code === 'REVIEW_STATE_CHANGED');
  assert.equal(state.handoffs, 0);
});

test('lỗi nguồn của hai ô cùng file có khóa riêng', async () => {
  const writes = [];
  const pool = { query: async (sql, values) => {
    writes.push({ sql, values });
    return { rows: [{ issue_key: values[0], status: 'open' }] };
  } };
  const service = createWritingFlowService({ pool });
  const base = { appId: 'app-demo', tableId: 'table-demo',
    recordId: 'record-demo', docId: 'doc-demo',
    linkIndex: 2, classCode: 'IC2200', reasonCode: 'INTAKE_TOPIC_MISSING' };
  const first = await service.recordSourceIssue({ ...base, essaySlot: 1 });
  const second = await service.recordSourceIssue({ ...base, essaySlot: 2 });
  const otherTable = await service.recordSourceIssue({ ...base,
    tableId: 'table-other', essaySlot: 1 });
  assert.notEqual(first.issue_key, second.issue_key);
  assert.notEqual(first.issue_key, otherTable.issue_key);
  assert.equal(writes[0].values[6], 1);
  assert.equal(writes[1].values[6], 2);
});
