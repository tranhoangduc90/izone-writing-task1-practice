import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowIntake } from '../src/writing-flow-intake.js';

function fakePool() {
  const pairs = [];
  const testPairs = [];
  const writes = [];
  const client = {
    async query(sql, values = []) {
      writes.push({ sql, values });
      if (sql.includes('INSERT INTO writing_flow.source_record')) {
        return { rowCount: 1, rows: [{ source_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }] };
      }
      if (sql.includes('INSERT INTO writing_flow.test_group')) {
        return { rowCount: 1, rows: [{ test_group_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }] };
      }
      if (sql.includes('SELECT pair_id, submission_revision, content_sha256, source_modified_at')) {
        const matching = pairs.filter(row => row.source_app_id === values[0]
          && row.source_table_id === values[1] && row.source_record_id === values[2]
          && row.homework_file_id === values[3]
          && row.source_link_index === values[4] && row.essay_slot === values[5]);
        matching.sort((a, b) => new Date(b.source_modified_at) - new Date(a.source_modified_at)
          || b.lark_modified_ms - a.lark_modified_ms);
        return { rowCount: matching.length ? 1 : 0, rows: matching.slice(0, 1) };
      }
      if (sql.includes('UPDATE writing_flow.pair SET status')) {
        for (const row of pairs) {
          if (row.source_app_id === values[0] && row.source_table_id === values[1]
            && row.source_record_id === values[2] && row.homework_file_id === values[3]
            && row.source_link_index === values[4] && row.essay_slot === values[5]) row.status = 'superseded';
        }
      }
      if (sql.includes('SET source_modified_at = GREATEST')) {
        const row = pairs.find(item => item.pair_id === values[0]);
        row.source_modified_at = new Date(Math.max(
          new Date(row.source_modified_at).getTime(), new Date(values[1]).getTime()));
        row.lark_modified_ms = Math.max(row.lark_modified_ms ?? 0, values[2]);
      }
      if (sql.includes('INSERT INTO writing_flow.pair_search_token')) {
        return { rowCount: Array.isArray(values[1]) ? values[1].length : 0, rows: [] };
      }
      if (sql.includes('INSERT INTO writing_flow.pair')) {
        const pair_id = `pair-${pairs.length + 1}`;
        pairs.push({ pair_id, source_app_id: values[0], source_table_id: values[1],
          source_record_id: values[2], homework_file_id: values[3],
          source_link_index: values[4], essay_slot: values[5], submission_revision: values[6],
          source_modified_at: values[7], lark_modified_ms: values[8],
          content_sha256: values[9], status: 'received' });
        return { rows: [{ pair_id }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO writing_flow.handoff')) {
        const handoff_id = `handoff-${writes.filter(row => row.sql.includes('INSERT INTO writing_flow.handoff')).length}`;
        return { rows: [{ handoff_id }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO writing_flow.test_pair')) {
        testPairs.push({ pairId: values[1], taskNumber: values[2], status: values[3],
          historicalEvidence: values[4] });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("count(*) FILTER (WHERE status='delivered')")) {
        return { rowCount: 1, rows: [{ total: testPairs.length,
          delivered: testPairs.filter(row => row.status === 'delivered').length }] };
      }
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client }, pairs, testPairs, writes };
}

function input() {
  return {
    sourceType: 'lark_homework',
    operationKey: 'scan-demo', appId: 'app-demo', tableId: 'table-demo',
    recordId: 'record-demo', docId: 'doc-demo',
    linkIndex: 2, classCode: 'IC2200', sourceModifiedAt: '2026-09-17T08:00:00.000Z',
    larkModifiedMs: 1789632000000,
    larkMeta: { classCode: 'IC2200', imageUrls: {
      1: 'https://example.test/chart-one', 2: '', 3: '', 4: 'https://example.test/chart-four',
    } },
    sourceMeta: { teacherNames: [] },
    documentKind: 'google_docs', verifiedMime: 'application/vnd.google-apps.document',
    expectedCount: 3, pairs: [1, 2, 4].map(essaySlot => ({
      essaySlot, taskType: essaySlot === 2 ? 'task_2' : 'task_1',
      topic: `Đề giả ${essaySlot}`,
      image: essaySlot === 2 ? '' : `https://example.test/chart-${essaySlot === 1 ? 'one' : 'four'}`,
      essay: `Bài giả ${essaySlot}`, trCcCheck: true,
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
  assert.ok(writes.filter(row => row.sql.includes('INSERT INTO writing_flow.handoff'))
    .every(row => row.sql.includes("now()+interval '6 hours'")));
  const resolved = writes.filter(row => row.sql.includes('UPDATE writing_flow.source_issue'));
  assert.deepEqual(resolved.map(row => row.values[5]), [1, 2, 4]);
  assert.ok(resolved.every(row => row.sql.includes('essay_slot=$6')));
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

test('đổi riêng cờ TR/CC tạo phiên bản mới dù file chưa đổi', async () => {
  const { pool, pairs } = fakePool();
  const intake = createWritingFlowIntake({ pool, encryptionKey: '11'.repeat(32) });
  await intake(input());
  const changed = input();
  changed.pairs.forEach(pair => { pair.trCcCheck = false; });
  changed.larkModifiedMs += 1000;
  const result = await intake(changed);
  assert.deepEqual(result.receipts.map(row => row.status), ['received', 'received', 'received']);
  const lateOldRead = await intake(input());
  assert.deepEqual(lateOldRead.receipts.map(row => row.status),
    ['stale_read', 'stale_read', 'stale_read']);
  const changedBack = input();
  changedBack.larkModifiedMs += 2000;
  const back = await intake(changedBack);
  assert.deepEqual(back.receipts.map(row => row.status), ['received', 'received', 'received']);
  assert.equal(pairs.length, 9);
  assert.notEqual(back.receipts[0].pairId, result.receipts[0].pairId);
  assert.equal(pairs.filter(row => row.status === 'superseded').length, 6);
  const conflicting = input();
  conflicting.larkModifiedMs += 3000;
  conflicting.pairs[0].essay = 'Nội dung đã đổi nhưng timestamp Drive không đổi';
  await assert.rejects(intake(conflicting), error => error.code === 'SOURCE_VERSION_CONFLICT');
});

test('cờ khác nhưng cùng mốc sửa Lark bị chặn thay vì ghi đè', async () => {
  const { pool, pairs } = fakePool();
  const intake = createWritingFlowIntake({ pool, encryptionKey: '11'.repeat(32) });
  await intake(input());
  const ambiguous = input();
  ambiguous.pairs.forEach(pair => { pair.trCcCheck = false; });
  await assert.rejects(intake(ambiguous),
    error => error.code === 'SOURCE_POLICY_VERSION_CONFLICT');
  await assert.rejects(intake({ ...ambiguous, larkModifiedMs: undefined }),
    error => error.code === 'LARK_MODIFIED_TIME_INVALID');
  assert.equal(pairs.length, 3);
});

test('bài Classroom đã cứu TR/CC không tạo cặp mới khi lượt quét mới chỉ đổi cờ chính sách', async () => {
  const { pool, pairs } = fakePool();
  const intake = createWritingFlowIntake({ pool, encryptionKey: '11'.repeat(32) });
  const source = input();
  source.sourceType = 'google_classroom';
  delete source.larkMeta;
  delete source.larkModifiedMs;
  source.expectedCount = 1;
  source.pairs = [{ essaySlot: 1, taskType: 'task_2', topic: 'Đề Classroom', image: '',
    essay: 'Bài Classroom', trCcCheck: false }];
  const first = await intake(source);
  assert.equal(first.receipts[0].status, 'received');
  pairs[0].trcc_required_override = true;
  const afterFix = structuredClone(source);
  afterFix.sourceModifiedAt = '2026-09-17T08:10:00.000Z';
  afterFix.pairs[0].trCcCheck = true;
  const second = await intake(afterFix);
  assert.equal(second.receipts[0].status, 'existing');
  assert.equal(second.receipts[0].pairId, first.receipts[0].pairId);
  assert.equal(pairs.length, 1);
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

test('mã hồ sơ giống nhau ở bảng Lark khác không ghi đè bài của bảng đầu', async () => {
  const { pool, pairs } = fakePool();
  const intake = createWritingFlowIntake({ pool, encryptionKey: '11'.repeat(32) });
  const first = await intake(input());
  const otherTable = { ...input(), tableId: 'table-other' };
  const second = await intake(otherTable);
  assert.ok(second.receipts.every(row => row.status === 'received'));
  assert.equal(pairs.length, 6);
  assert.equal(pairs.filter(row => row.status === 'superseded').length, 0);
  assert.notEqual(first.receipts[0].pairId, second.receipts[0].pairId);
});

test('bài mới lập chỉ mục tìm kiếm bằng dấu vân tay, không ghi nội dung rõ', async () => {
  const { pool, writes } = fakePool();
  await createWritingFlowIntake({ pool, encryptionKey: '11'.repeat(32) })(input());
  const searchWrites = writes.filter(row => row.sql.includes('writing_flow.pair_search_token'));
  assert.equal(searchWrites.length, 3);
  assert.equal(searchWrites.every(row => row.values[1].every(token => Buffer.isBuffer(token)
    && token.length === 32)), true);
  assert.equal(searchWrites.some(row => JSON.stringify(row.values).includes('Bài giả')), false);
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

test('bài Test đã có link kết quả được ghi nhận đã giao và không tạo bàn giao chấm lại', async () => {
  const { pool, testPairs, writes } = fakePool();
  const intake = createWritingFlowIntake({ pool, encryptionKey: '11'.repeat(32) });
  const source = input();
  source.sourceType = 'term_test';
  source.sourceMeta = { teacherNames: [], displayName: 'Term test 1 khóa Chuyên sâu',
    testConfig: 'Term Test 1' };
  delete source.larkMeta;
  delete source.larkModifiedMs;
  source.expectedCount = 1;
  source.pairs = [{ essaySlot: 1, taskType: 'task_2', topic: 'Đề Test', image: '',
    essay: 'Bài Test đã chấm', trCcCheck: true, alreadyGraded: true }];
  const result = await intake(source);
  assert.equal(result.receipts[0].status, 'existing');
  assert.equal(result.receipts[0].historicalEvidence, true);
  assert.deepEqual(testPairs, [{ pairId: result.receipts[0].pairId, taskNumber: 2,
    status: 'delivered', historicalEvidence: true }]);
  assert.equal(writes.some(row => row.sql.includes('INSERT INTO writing_flow.handoff')), false);
  assert.equal(writes.some(row => row.sql.includes("SET status='delivered'")), true);
  assert.equal(writes.some(row => row.sql.includes('evidence_status=CASE')), true);
});
