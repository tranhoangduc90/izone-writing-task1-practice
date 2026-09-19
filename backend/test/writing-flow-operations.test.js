import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowOperations, documentIdFromUrl, STAGES }
  from '../src/writing-flow-operations.js';

function poolWith(handler) {
  const client = {
    async query(sql, params = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      return handler(sql, params);
    },
    release() {},
  };
  return { connect: async () => client, query: client.query.bind(client) };
}

test('file thủ công chỉ nhận URL Google Docs thật', () => {
  const id = 'AbCdEfGhIjKlMnOpQrStUvWxYz12';
  assert.equal(documentIdFromUrl(`https://docs.google.com/document/d/${id}/edit`), id);
  assert.equal(documentIdFromUrl(`https://docs.google.com/document/d/${id}`), id);
  assert.equal(documentIdFromUrl(`https://drive.google.com/file/d/${id}/view`), '');
  assert.equal(documentIdFromUrl(`https://docs.google.com.evil.invalid/document/d/${id}/edit`), '');
  assert.equal(documentIdFromUrl(`http://docs.google.com/document/d/${id}/edit`), '');
  assert.equal(documentIdFromUrl('không-phải-link'), '');
});

test('thêm file thủ công lưu URL chuẩn, tên hiển thị và sự kiện chống bấm lặp', async () => {
  const queries = [];
  const source = { source_id: '11111111-1111-4111-8111-111111111111',
    display_name: 'Bài chữa thêm', dispatch_status: 'pending' };
  const pool = poolWith(async (sql, params) => {
    queries.push({ sql, params });
    if (sql.includes('FROM writing_flow.operator_event')) return { rowCount: 0, rows: [] };
    if (sql.includes('INSERT INTO writing_flow.source_record')) return { rowCount: 1, rows: [source] };
    if (sql.includes('INSERT INTO writing_flow.operator_event')) return { rowCount: 1, rows: [] };
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  });
  const operations = createWritingFlowOperations({ pool });
  const result = await operations.addManualSource({
    displayName: '  Bài chữa thêm  ',
    documentUrl: 'https://docs.google.com/document/d/AbCdEfGhIjKlMnOpQrStUvWxYz12/edit?tab=t.0',
    requestId: '22222222-2222-4222-8222-222222222222',
    actorRef: 'admin@example.invalid',
  });
  assert.equal(result.source_id, source.source_id);
  const insert = queries.find(item => item.sql.includes('INSERT INTO writing_flow.source_record'));
  assert.equal(insert.params[2], 'Bài chữa thêm');
  assert.equal(insert.params[3],
    'https://docs.google.com/document/d/AbCdEfGhIjKlMnOpQrStUvWxYz12/edit');
  assert.match(insert.sql, /'manual','manual_dashboard','manual:' \|\| \$1/u);
  assert.equal(queries.some(item => item.sql.includes("'manual_source_added'")), true);
});

test('bấm lại cùng request ID trả đúng nguồn cũ và không chèn lần hai', async () => {
  let inserted = false;
  const sourceId = '11111111-1111-4111-8111-111111111111';
  const pool = poolWith(async sql => {
    if (sql.includes('FROM writing_flow.operator_event')) {
      return { rowCount: 1, rows: [{ source_id: sourceId, event_type: 'manual_source_added' }] };
    }
    if (sql.includes('FROM writing_flow.source_record WHERE source_id')) {
      return { rowCount: 1, rows: [{ source_id: sourceId, dispatch_status: 'pending' }] };
    }
    if (sql.includes('INSERT')) inserted = true;
    return { rowCount: 0, rows: [] };
  });
  const result = await createWritingFlowOperations({ pool }).addManualSource({
    displayName: 'Bài chữa thêm',
    documentUrl: 'https://docs.google.com/document/d/AbCdEfGhIjKlMnOpQrStUvWxYz12/edit',
    requestId: '22222222-2222-4222-8222-222222222222', actorRef: 'admin@example.invalid',
  });
  assert.equal(result.source_id, sourceId);
  assert.equal(inserted, false);
});

test('hàng nguồn nhận 50 file mặc định, khóa SKIP LOCKED và không còn cap ba bài', async () => {
  const ids = Array.from({ length: 20 }, (_, index) =>
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`);
  const observed = [];
  const pool = poolWith(async (sql, params) => {
    observed.push({ sql, params });
    if (sql.includes('SELECT s.source_id')) return { rowCount: ids.length,
      rows: ids.map(source_id => ({ source_id })) };
    if (sql.includes('UPDATE writing_flow.source_record')) return { rowCount: ids.length,
      rows: ids.map(source_id => ({ source_id, dispatch_count: 1 })) };
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  });
  const rows = await createWritingFlowOperations({ pool }).claimDueSources();
  assert.equal(rows.length, 20);
  assert.equal(observed[0].params[1], 50);
  assert.match(observed[0].sql, /FOR UPDATE OF s SKIP LOCKED LIMIT \$2/u);
  assert.match(observed[0].sql, /NOT EXISTS[\s\S]*scan_run[\s\S]*source_table_id=s\.source_table_id/u);
  assert.doesNotMatch(observed[0].sql, /scan_item/u);
  assert.deepEqual(observed[1].params[0], ids);
});

test('nguồn được xác nhận thành công sẽ không tự phát lại', async () => {
  let seenParams;
  const pool = poolWith(async (sql, params) => {
    seenParams = params;
    assert.match(sql, /next_dispatch_at=NULL/u);
    return { rowCount: 1, rows: [{ source_id: params[0], dispatch_status: params[1] }] };
  });
  const result = await createWritingFlowOperations({ pool }).acknowledgeSource({
    sourceId: '11111111-1111-4111-8111-111111111111', outcome: 'accepted' });
  assert.equal(result.dispatch_status, 'acknowledged');
  assert.equal(seenParams[1], 'acknowledged');
});

test('retry không nhận intake, không nhận bài đã bỏ qua và làm mới đúng bước trở về sau', async () => {
  const operationsInvalid = createWritingFlowOperations({ pool: poolWith(async () => ({ rows: [] })) });
  await assert.rejects(() => operationsInvalid.requestStageRetry({ stageKey: 'intake' }),
    error => error.code === 'STAGE_RETRY_INVALID');

  const pairId = '11111111-1111-4111-8111-111111111111';
  const requestId = '22222222-2222-4222-8222-222222222222';
  const statements = [];
  const pool = poolWith(async (sql, params) => {
    statements.push({ sql, params });
    if (sql.includes('FROM writing_flow.operator_event')) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM writing_flow.pair WHERE pair_id=$1 FOR UPDATE')) {
      return { rowCount: 1, rows: [{ pair_id: pairId, status: 'needs_review', skipped_at: null }] };
    }
    if (sql.includes('FROM writing_flow.stage_result WHERE pair_id=$1 FOR UPDATE')) {
      return { rowCount: 4, rows: STAGES.slice(3).map((stage_key, index) => ({
        stage_key, status: index === 0 ? 'needs_review' : 'succeeded', cycle_no: 1,
      })) };
    }
    return { rowCount: 1, rows: [] };
  });
  const result = await createWritingFlowOperations({ pool }).requestStageRetry({
    pairId, stageKey: 'critic', requestId, actorRef: 'admin@example.invalid', reason: 'Thử lại',
  });
  assert.deepEqual(result.invalidatedStages, ['critic', 'arbiter', 'render', 'deliver']);
  const reset = statements.find(item => item.sql.includes("SET status='pending'"));
  assert.equal(reset.params[2], 4);
  assert.deepEqual(reset.params[1], STAGES);
  assert.equal(statements.some(item => item.sql.includes("'SUPERSEDED_BY_OPERATOR_RETRY'")), true);
});

test('migration vận hành không có DELETE và có bảng nguồn, sổ lớp, thao tác, lịch sử', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../../docs/migrations/2026-09-20-writing-flow-operations-v2.sql',
    import.meta.url), 'utf8');
  for (const table of ['source_record', 'class_registry', 'operator_event',
    'pair_source_version', 'legacy_record']) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS writing_flow\\.${table}`, 'u'));
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/iu);
  assert.doesNotMatch(sql, /GRANT\s+DELETE/iu);
});
