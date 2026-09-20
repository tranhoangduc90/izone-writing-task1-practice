import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowScan, shouldResolvePriorTechnicalIssue,
  shouldRetrySourceIssue } from '../src/writing-flow-scan.js';

const key = 'a'.repeat(64);
const request = {
  appId: 'app-demo', tableId: 'table-demo', recordId: 'record-demo',
  docId: 'doc-demo', linkIndex: 2,
  expectedPairs: [{ essaySlot: 1, revision: 'b'.repeat(64) }],
  expectedIssues: [{ essaySlot: 2, reasonCode: 'SOURCE_MISSING' }],
};

test('lỗi đọc kỹ thuật được thử tối đa ba lượt còn lỗi nguồn thật dừng ngay', () => {
  assert.equal(shouldRetrySourceIssue('issue', ['FETCH_FAILED']), true);
  assert.equal(shouldRetrySourceIssue('issue', ['SOURCE_METADATA_MISSING']), true);
  assert.equal(shouldRetrySourceIssue('issue', ['TABLE_STRUCTURE_INVALID']), false);
  assert.equal(shouldRetrySourceIssue('issue', ['FETCH_FAILED', 'TABLE_STRUCTURE_INVALID']), false);
  assert.equal(shouldRetrySourceIssue('accepted', ['FETCH_FAILED']), false);
  assert.equal(shouldResolvePriorTechnicalIssue('empty', false), true);
  assert.equal(shouldResolvePriorTechnicalIssue('issue', false), true);
  assert.equal(shouldResolvePriorTechnicalIssue('issue', true), false);
});

test('biên nhận FETCH_FAILED đưa nguồn về hàng chờ khi chưa đủ ba lượt', async () => {
  let sourceUpdate = null;
  const issueKey = 'e'.repeat(64);
  const client = { async query(sql, args) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
    if (sql.includes('SELECT i.*,r.status AS run_status')) return { rowCount: 1, rows: [{
      run_status: 'open', status: 'pending', source_app_id: 'app-demo',
      source_table_id: 'table-demo', source_record_id: 'record-demo',
      homework_file_id: 'doc-demo', source_link_index: 2,
    }] };
    if (sql.includes('FROM writing_flow.source_issue')) return { rowCount: 1, rows: [{
      issue_key: issueKey, essay_slot: null, reason_code: 'FETCH_FAILED',
    }] };
    if (sql.includes('UPDATE writing_flow.scan_item')) return { rowCount: 1 };
    if (sql.includes('UPDATE writing_flow.source_record')) {
      sourceUpdate = { sql, args };
      return { rowCount: 1 };
    }
    throw new Error(`UNEXPECTED_QUERY:${sql}`);
  }, release() {} };
  const service = createWritingFlowScan({ pool: { connect: async () => client } });
  await service.acknowledge({ runId: 'run-demo', itemKey: key,
    status: 'issue', issueKeys: [issueKey], detectedSlotCount: null });
  assert.match(sourceUpdate.sql, /dispatch_count<3/u);
  assert.match(sourceUpdate.sql, /interval '30 seconds'/u);
  assert.equal(sourceUpdate.args[6], true);
  assert.equal(sourceUpdate.args[7], 'FETCH_FAILED');
});

test('đọc lại lỗi nguồn tạo đúng một lượt quét idempotent và giữ nguyên mốc', async () => {
  const issueKey = 'd'.repeat(64);
  const requestId = '22222222-2222-4222-8222-222222222222';
  const pool = { async query(sql, args) {
    if (sql.includes('FROM writing_flow.source_issue')) {
      assert.deepEqual(args, [issueKey]);
      return { rowCount: 1, rows: [{
        source_app_id: 'app-demo', source_table_id: 'table-demo',
        source_record_id: 'record-demo', homework_file_id: 'doc-demo',
        source_link_index: 2, class_code: 'IC2200',
      }] };
    }
    throw new Error(`UNEXPECTED_QUERY:${sql}`);
  } };
  const service = createWritingFlowScan({ pool });
  service.cursor = async () => ({ scannedThroughAt: '2026-09-19T12:00:00.000Z' });
  let received;
  service.begin = async input => { received = input; return { status: 'open', items: input.items }; };
  const result = await service.retrySourceIssue({ issueKey, requestId });
  assert.equal(result.status, 'open');
  assert.deepEqual(received, {
    requestKey: `source-issue-retry:${requestId}`,
    appId: 'app-demo', tableId: 'table-demo',
    scannedThroughAt: '2026-09-19T12:00:00.000Z',
    pageCount: 1, reachedEnd: true,
    items: [{ recordId: 'record-demo', docId: 'doc-demo',
      linkIndex: 2, classCode: 'IC2200' }],
  });
});

test('lượt gửi lại mang đủ metadata của nguồn Classroom để không đọc nhầm Lark', async () => {
  const client = { async query(sql) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return {};
    if (sql.includes('UPDATE writing_flow.scan_item i')) {
      assert.match(sql, /LEFT JOIN writing_flow\.source_record/u);
      return { rows: [{ run_id: 'run-demo', item_key: key,
        source_record_id: 'submission-demo', homework_file_id: 'doc-demo',
        source_link_index: 1, class_code: 'IC2200', send_count: 2,
        source_app_id: 'google_classroom', source_table_id: 'course-demo',
        source_id: '11111111-1111-4111-8111-111111111111',
        source_type: 'google_classroom', source_updated_at: '2026-09-20T00:00:00.000Z',
        file_url: 'https://docs.google.com/document/d/doc-demo/edit',
        display_name: 'Writing homework', student_name: 'Học viên',
        teacher_names: ['Giảng viên'], classroom_url: 'https://classroom.google.com/x',
        source_status: 'TURNED_IN', source_created_at: '2026-09-19T00:00:00.000Z',
        metadata: { courseWorkId: 'cw-demo' } }] };
    }
    throw new Error(`UNEXPECTED_QUERY:${sql}`);
  }, release() {} };
  const service = createWritingFlowScan({ pool: { connect: async () => client } });
  const rows = await service.due({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].sourceType, 'google_classroom');
  assert.equal(rows[0].sourceId, '11111111-1111-4111-8111-111111111111');
  assert.equal(rows[0].sourceMeta.displayName, 'Writing homework');
  assert.equal(rows[0].sourceMeta.courseWorkId, 'cw-demo');
});

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
  assert.deepEqual(await service.finishReady({ limit: 10 }),
    { scans: [], failureCount: 0, failures: [] });
  assert.equal(attempted, 1);
});

test('một link lỗi vẫn cho link và lượt quét khác chốt, rồi báo lỗi để gửi lại', async () => {
  const firstKey = 'a'.repeat(64);
  const secondKey = 'b'.repeat(64);
  const plan = { status: 'accepted', detectedSlotCount: 1,
    receiptRequest: { ...request, expectedIssues: [] } };
  const pool = { async query(sql) {
    if (sql.includes('i.receipt_plan IS NOT NULL')) return { rows: [
      { run_id: 'run-bad', item_key: firstKey, receipt_plan: plan,
        receipt_plan_sha256: 'sha-1' },
      { run_id: 'run-good', item_key: secondKey, receipt_plan: plan,
        receipt_plan_sha256: 'sha-2' },
    ] };
    if (sql.includes('NOT EXISTS')) return { rows: [
      { run_id: 'run-bad' }, { run_id: 'run-good' },
    ] };
    throw new Error('UNEXPECTED_QUERY');
  } };
  const service = createWritingFlowScan({ pool });
  const acknowledged = [];
  const finished = [];
  let receiptCalls = 0;
  service.receipts = async () => {
    receiptCalls += 1;
    if (receiptCalls === 1) throw Object.assign(new Error('database down'),
      { code: '08006' });
    return { pairIds: ['pair-1'], issueKeys: [] };
  };
  service.acknowledge = async input => { acknowledged.push(input.itemKey); };
  service.finish = async ({ runId }) => {
    finished.push(runId);
    if (runId === 'run-bad') throw Object.assign(new Error('busy'), { code: '55P03' });
    return { runId, status: 'complete' };
  };
  const result = await service.finishReady({ limit: 10 });
  assert.equal(result.failureCount, 2);
  assert.deepEqual(result.failures.map(item => item.code), ['08006', '55P03']);
  assert.deepEqual(result.scans, [{ runId: 'run-good', status: 'complete' }]);
  assert.deepEqual(acknowledged, [secondKey]);
  assert.deepEqual(finished, ['run-bad', 'run-good']);
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
