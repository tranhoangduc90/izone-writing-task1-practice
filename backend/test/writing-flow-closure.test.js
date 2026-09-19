import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowScan, verifyClosureContent } from '../src/writing-flow-scan.js';

// Nhận vào: trạng thái giả của lượt quét, lỗi nguồn và hai ô bài.
// Việc chính: trả đúng các hàng mà phép kiểm chốt hồ sơ đọc từ database.
// Trả ra: quyết định của API; khi còn ô lỗi hoặc chưa có link, hồ sơ phải mở.
function fixture({ runStatus = 'complete', itemStatus = 'accepted',
  issueCount = 0, pairStatuses = ['delivered', 'delivered'],
  deliveryStatuses = ['succeeded', 'succeeded'], expectedPairCount = 2,
  receiptPairIds = ['pair-1', 'pair-2'], wrongRecord = false,
  wrongFile = false, wrongLink = false,
  duplicateSlot = false, previousRevisions = null } = {}) {
  const pool = { async query(sql) {
    if (sql.includes('FROM writing_flow.scan_run r')) {
      return { rowCount: runStatus === 'missing' ? 0 : 1,
        rows: [{ run_id: 'run-1', status: runStatus,
          scanned_through_at: '2026-09-17T08:00:00Z' }] };
    }
    if (sql.includes('FROM writing_flow.source_issue')) {
      return { rowCount: 1, rows: [{ issue_count: issueCount }] };
    }
    if (sql.includes('FROM writing_flow.record_closure c')) {
      return { rowCount: previousRevisions ? 1 : 0,
        rows: previousRevisions ? [{ run_id: 'run-old' }] : [] };
    }
    if (sql.includes('FROM writing_flow.scan_item i')) {
      return { rowCount: previousRevisions?.length || 0,
        rows: (previousRevisions || []).map((revision, index) => ({
          source_link_index: 1, homework_file_id: 'doc-1',
          essay_slot: index + 1, submission_revision: revision,
        })) };
    }
    if (sql.includes('FROM writing_flow.scan_item')) {
      return { rowCount: 1, rows: [{ source_link_index: 1,
        homework_file_id: 'doc-1', status: itemStatus,
        expected_pair_count: expectedPairCount,
        receipt_pair_ids: receiptPairIds }] };
    }
    if (sql.includes('FROM writing_flow.pair p')) {
      const rows = pairStatuses.map((status, index) => ({
        pair_id: receiptPairIds[index], status,
        source_app_id: 'app-demo', source_table_id: 'table-demo',
        source_record_id: wrongRecord && index === 1 ? 'other-record' : 'record-demo',
        homework_file_id: wrongFile && index === 1 ? 'doc-2' : 'doc-1',
        source_link_index: wrongLink && index === 1 ? 2 : 1,
        essay_slot: duplicateSlot ? 1 : index + 1,
        submission_revision: `revision-${index + 1}`,
        delivery_status: deliveryStatuses[index],
      }));
      return { rowCount: rows.length, rows };
    }
    throw new Error('UNEXPECTED_QUERY');
  } };
  return createWritingFlowScan({ pool }).closureEligibility({
    appId: 'app-demo', tableId: 'table-demo', recordId: 'record-demo',
  });
}

test('chỉ chốt hồ sơ khi hai ô bài đã giao và đã đọc lại link', async () => {
  const result = await fixture();
  assert.equal(result.eligible, true);
  assert.equal(result.expectedPairCount, 2);
  assert.equal(result.needsNewTimestamp, true);
  assert.deepEqual(result.links, [{ linkIndex: 1, docId: 'doc-1',
    expectedPairs: [
      { essaySlot: 1, revision: 'revision-1' },
      { essaySlot: 2, revision: 'revision-2' },
    ] }]);
});

test('mốc cũ chỉ được giữ nếu đúng cả hai phiên bản bài đã chốt trước đó', async () => {
  assert.equal((await fixture({ previousRevisions: [
    'revision-1', 'revision-2' ] })).needsNewTimestamp, false);
  assert.equal((await fixture({ previousRevisions: [
    'revision-1', 'revision-moi' ] })).needsNewTimestamp, true);
});

test('giữ hồ sơ mở khi lượt quét chưa xong hoặc còn lỗi nguồn', async () => {
  assert.equal((await fixture({ runStatus: 'missing' })).reason, 'SCAN_NOT_FOUND');
  assert.equal((await fixture({ runStatus: 'open' })).reason, 'SCAN_NOT_COMPLETE');
  assert.equal((await fixture({ itemStatus: 'partial' })).reason, 'SCAN_ITEM_UNRESOLVED');
  assert.equal((await fixture({ issueCount: 1 })).reason, 'SOURCE_ISSUE_OPEN');
});

test('giữ hồ sơ mở khi thiếu một ô hoặc link chưa đọc lại', async () => {
  assert.equal((await fixture({ pairStatuses: ['delivered'] })).reason,
    'SCAN_RECEIPT_MISMATCH');
  assert.equal((await fixture({ pairStatuses: ['delivered', 'running'] })).reason,
    'PAIR_NOT_DELIVERED');
  assert.equal((await fixture({ deliveryStatuses: ['succeeded', 'running'] })).reason,
    'PAIR_NOT_DELIVERED');
  assert.equal((await fixture({ itemStatus: 'empty', expectedPairCount: 0 })).reason,
    'NO_WRITING_PAIR');
  assert.equal((await fixture({ receiptPairIds: ['pair-1'] })).reason,
    'SCAN_RECEIPT_MISMATCH');
  assert.equal((await fixture({ wrongRecord: true })).reason,
    'SCAN_RECEIPT_MISMATCH');
  assert.equal((await fixture({ wrongFile: true })).reason,
    'SCAN_RECEIPT_MISMATCH');
  assert.equal((await fixture({ wrongLink: true })).reason,
    'SCAN_RECEIPT_MISMATCH');
  assert.equal((await fixture({ duplicateSlot: true })).reason,
    'SCAN_RECEIPT_MISMATCH');
});

test('API chỉ nhận bằng chứng đọc lại đủ file và đúng dấu vân tay', () => {
  const revision = 'a'.repeat(64);
  const expected = { eligible: true, expectedPairCount: 1,
    links: [{ linkIndex: 1, docId: 'doc-one', expectedPairs: [
      { essaySlot: 1, revision },
    ] }] };
  const observed = [{ linkIndex: 1, docId: 'doc-one', status: 'accepted',
    observedAtMs: Date.now(), receiptRequest: { expectedPairs: [
      { essaySlot: 1, revision },
    ] } }];
  assert.deepEqual(verifyClosureContent(expected, observed),
    { verifiedLinkCount: 1, verifiedPairCount: 1 });
  assert.throws(() => verifyClosureContent(expected, []),
    error => error.code === 'CLOSURE_CONTENT_PROOF_MISSING');
  assert.throws(() => verifyClosureContent(expected, [{ ...observed[0],
    observedAtMs: Date.now() - 6 * 60_000 }]),
  error => error.code === 'CLOSURE_CONTENT_PROOF_STALE');
  assert.throws(() => verifyClosureContent(expected, [{ ...observed[0],
    receiptRequest: { expectedPairs: [{ essaySlot: 1, revision: 'b'.repeat(64) }] } }]),
  error => error.code === 'CLOSURE_ESSAY_CHANGED');
  assert.throws(() => verifyClosureContent(expected, [{ ...observed[0],
    status: 'empty' }]),
  error => error.code === 'CLOSURE_CONTENT_PROOF_MISMATCH');
  assert.throws(() => verifyClosureContent(expected, [{ ...observed[0],
    receiptRequest: { expectedPairs: [] } }]),
  error => error.code === 'CLOSURE_CONTENT_PROOF_MISMATCH');
});
