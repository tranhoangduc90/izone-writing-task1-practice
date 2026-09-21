import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createWritingFlowHandoff } from '../src/writing-flow-handoff.js';

const migrationUrl = new URL('../../docs/migrations/2026-09-21-writing-flow-trcc-repair-v8.sql',
  import.meta.url);

test('migration cứu TR/CC có hàng đợi, lịch sử lượt thử, ba trạng thái kết thúc và không có DELETE', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS writing_flow\.trcc_repair\s*\(/u);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS writing_flow\.trcc_repair_attempt\s*\(/u);
  assert.match(sql, /attempt_count BETWEEN 0 AND 3/u);
  assert.match(sql, /trcc_repair_seeded/u);
  assert.match(sql, /trcc_repair_completed/u);
  assert.match(sql, /trcc_repair_failed/u);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/iu);
});

test('bàn giao cứu TR/CC vẫn được cấp khi bài cũ đã ở trạng thái đã giao', async () => {
  const calls = [];
  const client = {
    async query(sql, values = []) {
      calls.push({ sql, values });
      if (sql.includes('RETURNING h.handoff_id')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  await createWritingFlowHandoff({ pool: { connect: async () => client } }).due(20);
  const cleanup = calls.find(call => call.sql.includes("p.status='delivered'"));
  const claim = calls.find(call => call.sql.includes('WITH ready AS'));
  assert.match(cleanup.sql, /h\.to_stage<>'trcc_repair'/u);
  assert.match(claim.sql, /p\.status<>'delivered' OR h\.to_stage='trcc_repair'/u);
});

test('source và stage chỉ dùng cờ override để cứu TR/CC, không xóa kết quả chấm chính', async () => {
  const [intake, stage, repair] = await Promise.all([
    readFile(new URL('../src/writing-flow-intake.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/writing-flow-stage.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/writing-flow-trcc-repair.js', import.meta.url), 'utf8'),
  ]);
  assert.match(intake, /directTrccRepairEquivalent/u);
  assert.match(stage, /TRCC_REPAIR_RESULT_MISSING/u);
  assert.match(stage, /trcc_mode: 'repair'/u);
  assert.match(repair, /stage_key IN \('render','deliver'\)/u);
  assert.doesNotMatch(repair, /stage_key IN \('main','critic','arbiter'/u);
  assert.doesNotMatch(repair, /DELETE FROM/u);
});

test('hàng cứu chỉ nhận danh sách bài đã đối chiếu, không tự quét rộng toàn lịch sử', async () => {
  const [app, repair] = await Promise.all([
    readFile(new URL('../src/app.js', import.meta.url), 'utf8'),
    readFile(new URL('../src/writing-flow-trcc-repair.js', import.meta.url), 'utf8'),
  ]);
  assert.match(app, /pairIds:z\.array\(uuid\)\.min\(1\)\.max\(5000\)/u);
  assert.match(repair, /async function seed\(\{ batchRequestId, pairIds,/u);
  assert.match(repair, /p\.pair_id=ANY\(\$1::uuid\[\]\)/u);
  assert.doesNotMatch(repair, /LIMIT \$1 FOR UPDATE OF p SKIP LOCKED/u);
});

test('bài cứu quá hạn lần ba ép kiểu tham số trước khi ghi JSON log', async () => {
  // Regression production 21/09: PostgreSQL 42P08 làm workflow điều phối lỗi mỗi phút
  // vì attemptCount chỉ xuất hiện trong hàm jsonb_build_object đa hình.
  const repair = await readFile(new URL('../src/writing-flow-trcc-repair.js', import.meta.url),
    'utf8');
  assert.match(repair,
    /jsonb_build_object\('attemptCount',\$4::integer\)/u);
  assert.match(repair,
    /jsonb_build_object\('repairStatus','needs_review','errorCode',\$3::text\)/u);
});
