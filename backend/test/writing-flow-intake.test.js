import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowIntake } from '../src/writing-flow-intake.js';

function fakePool() {
  const pairs = [];
  const writes = [];
  const client = {
    async query(sql, values = []) {
      writes.push({ sql, values });
      if (sql.includes('SELECT pair_id, submission_revision, source_modified_at')) {
        const matching = pairs.filter(row => row.source_record_id === values[0]
          && row.homework_file_id === values[1]
          && row.source_link_index === values[2] && row.essay_slot === values[3]);
        matching.sort((a, b) => new Date(b.source_modified_at) - new Date(a.source_modified_at));
        return { rowCount: matching.length ? 1 : 0, rows: matching.slice(0, 1) };
      }
      if (sql.includes('UPDATE writing_flow.pair SET status')) {
        for (const row of pairs) {
          if (row.source_record_id === values[0] && row.homework_file_id === values[1]
            && row.source_link_index === values[2] && row.essay_slot === values[3]) row.status = 'superseded';
        }
      }
      if (sql.includes('SET source_modified_at = $2')) {
        const row = pairs.find(item => item.pair_id === values[0]);
        row.source_modified_at = values[1];
      }
      if (sql.includes('INSERT INTO writing_flow.pair')) {
        const pair_id = `pair-${pairs.length + 1}`;
        pairs.push({ pair_id, source_record_id: values[0], homework_file_id: values[1],
          source_link_index: values[2], essay_slot: values[3], submission_revision: values[4],
          source_modified_at: values[5], status: 'received' });
        return { rows: [{ pair_id }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO writing_flow.handoff')) {
        const handoff_id = `handoff-${writes.filter(row => row.sql.includes('INSERT INTO writing_flow.handoff')).length}`;
        return { rows: [{ handoff_id }], rowCount: 1 };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client }, pairs, writes };
}

function input() {
  return {
    operationKey: 'scan-demo', recordId: 'record-demo', docId: 'doc-demo',
    linkIndex: 2, classCode: 'IC2200', sourceModifiedAt: '2026-09-17T08:00:00.000Z',
    larkMeta: { classCode: 'IC2200', imageUrls: {
      1: 'https://example.test/chart-one', 2: '', 3: '', 4: 'https://example.test/chart-four',
    } },
    documentKind: 'google_docs', verifiedMime: 'application/vnd.google-apps.document',
    expectedCount: 3, pairs: [1, 2, 4].map(essaySlot => ({
      essaySlot, taskType: essaySlot === 2 ? 'task_2' : 'task_1',
      topic: `Đề giả ${essaySlot}`,
      image: essaySlot === 2 ? '' : `https://example.test/chart-${essaySlot === 1 ? 'one' : 'four'}`,
      essay: `Bài giả ${essaySlot}`,
    })),
  };
}

test('ba ô 1, 2, 4 tạo ba bàn giao; quét lại và sửa một ô không chấm lại ô khác', async () => {
  const { pool, pairs, writes } = fakePool();
  const intake = createWritingFlowIntake({ pool, encryptionKey: '11'.repeat(32) });
  const first = await intake(input());
  assert.deepEqual(first.receipts.map(row => row.essaySlot), [1, 2, 4]);
  assert.ok(first.receipts.every(row => row.status === 'received'
    && /^[0-9a-f]{64}$/.test(row.revision) && row.handoffId));
  assert.equal(writes.filter(row => row.sql.includes('INSERT INTO writing_flow.handoff')).length, 3);
  const resolved = writes.filter(row => row.sql.includes('UPDATE writing_flow.source_issue'));
  assert.deepEqual(resolved.map(row => row.values[3]), [1, 2, 4]);
  assert.ok(resolved.every(row => row.sql.includes('essay_slot=$4')));
  const duplicate = await intake(input());
  assert.deepEqual(duplicate.receipts.map(row => row.status), ['existing', 'existing', 'existing']);
  assert.ok(duplicate.receipts.every(row => !row.handoffId));
  assert.equal(writes.filter(row => row.sql.includes('INSERT INTO writing_flow.handoff')).length, 3);
  const revised = input();
  revised.sourceModifiedAt = '2026-09-17T08:05:00.000Z';
  revised.pairs[2].essay = 'Bài giả 4 đã sửa';
  const third = await intake(revised);
  assert.deepEqual(third.receipts.map(row => row.status), ['existing', 'existing', 'received']);
  assert.equal(writes.filter(row => row.sql.includes('INSERT INTO writing_flow.handoff')).length, 4);
  assert.equal(pairs.filter(row => row.status === 'superseded').length, 1);
  const stale = await intake(input());
  assert.equal(stale.receipts[2].status, 'stale_read');
  assert.equal(writes.filter(row => row.sql.includes('INSERT INTO writing_flow.handoff')).length, 4);
  assert.equal(writes.some(row => row.values.some(value => typeof value === 'string' && value.includes('Bài giả'))), false);
});

test('MIME sai hoặc thiếu khóa mã hóa dừng trước khi mở transaction', async () => {
  const { pool, writes } = fakePool();
  const withoutKey = createWritingFlowIntake({ pool, encryptionKey: null });
  await assert.rejects(withoutKey(input()), error => error.code === 'WRITING_FLOW_ENCRYPTION_NOT_READY');
  const intake = createWritingFlowIntake({ pool, encryptionKey: '11'.repeat(32) });
  await assert.rejects(intake({ ...input(), verifiedMime: 'video/quicktime' }),
    error => error.code === 'FILE_MIME_MISMATCH');
  assert.equal(writes.length, 0);
});

test('IC2288 không tạo bản ghi chấm dù có bài trong file', async () => {
  const { pool, writes } = fakePool();
  const intake = createWritingFlowIntake({ pool, encryptionKey: '11'.repeat(32) });
  const source = input();
  source.classCode = 'ic2288';
  source.larkMeta.classCode = 'ic2288';
  const result = await intake(source);
  assert.equal(result.reason, 'CLASS_EXCLUDED');
  assert.equal(writes.length, 0);
});

test('không nhận lớp hoặc loại đề khác với bốn field homework', async () => {
  const { pool, writes } = fakePool();
  const intake = createWritingFlowIntake({ pool, encryptionKey: '11'.repeat(32) });
  const wrongClass = input();
  wrongClass.larkMeta.classCode = 'IC9999';
  await assert.rejects(intake(wrongClass), error => error.code === 'LARK_CLASS_MISMATCH');
  const wrongTask = input();
  wrongTask.pairs[1].taskType = 'task_1';
  await assert.rejects(intake(wrongTask), error => error.code === 'LARK_TASK_TYPE_MISMATCH');
  assert.equal(writes.length, 0);
});
