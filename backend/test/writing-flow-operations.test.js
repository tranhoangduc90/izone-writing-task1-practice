import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowOperations, documentIdFromUrl, STAGES }
  from '../src/writing-flow-operations.js';
import { seal } from '../src/writing-flow-crypto.js';

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
  assert.match(observed[0].sql, /greatest\(0,100-count\(\*\)\)/u);
  assert.match(observed[0].sql,
    /FOR UPDATE OF s SKIP LOCKED[\s\S]*LIMIT least\(\$2,\(SELECT available FROM capacity\)\)/u);
  assert.match(observed[0].sql, /NOT EXISTS[\s\S]*scan_run[\s\S]*source_table_id=s\.source_table_id/u);
  assert.match(observed[0].sql, /last_dispatched_at[\s\S]*interval '6 hours'/u);
  assert.doesNotMatch(observed[0].sql, /scan_item/u);
  assert.deepEqual(observed[1].params[0], ids);
  assert.match(observed[1].sql, /next_dispatch_at=now\(\)\+interval '6 hours'/u);
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

test('đồng bộ Classroom bổ sung tên homework cho nguồn chuyển tiếp sau mỗi lượt', async () => {
  const statements = [];
  const pool = poolWith(async (sql, params) => {
    statements.push({ sql, params });
    if (sql.includes('INSERT INTO writing_flow.source_record')) return { rowCount: 1,
      rows: [{ source_id: '11111111-1111-4111-8111-111111111111' }] };
    if (sql.includes('WITH classroom_candidate')) return { rowCount: 1, rows: [] };
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  });
  await createWritingFlowOperations({ pool }).upsertClassroomSources({ sources: [{
    courseId: 'course', submissionId: 'submission', documentId: 'doc', linkIndex: 1,
    displayName: 'Writing homework 12', classCode: 'IC2200', studentName: 'Học viên giả',
    teacherNames: ['Giảng viên giả'], classroomUrl: 'https://classroom.google.com/c/demo',
    fileUrl: 'https://docs.google.com/document/d/demo/edit', sourceStatus: 'TURNED_IN',
    sourceUpdatedAt: '2026-09-20T00:00:00Z',
  }] });
  const backfill = statements.find(item => item.sql.includes('WITH classroom_candidate'));
  assert.match(backfill.sql, /count\(\*\) OVER \(PARTITION BY homework_file_id\)/u);
  assert.match(backfill.sql, /homework_file_id=ANY\(\$1::text\[\]\)/u);
  assert.deepEqual(backfill.params, [['doc']]);
  assert.match(backfill.sql, /display_name=coalesce/u);
  assert.match(backfill.sql, /legacy\.source_type='lark_homework'/u);
});

test('lịch sử chỉ trả bản mới nhất mỗi ô và giải mã các field dashboard', async () => {
  const hexKey = '22'.repeat(32);
  const snapshot = { homeworkTitle: 'Writing homework 12',
    classroomUrl: 'https://classroom.google.com/c/demo', topic: 'Đề giả',
    essay: 'Nội dung bài giả', image: 'https://example.invalid/chart.png',
    trcc: true, lms: 'https://ducizone.ddns.net/writing/shared/writing-essays/'
      + `${'a'.repeat(48)}/view?v=1` };
  const pool = poolWith(async sql => {
    assert.match(sql, /DISTINCT ON \(legacy\.source_app_id,legacy\.source_table_id,[\s\S]*legacy\.source_record_id,legacy\.essay_slot\)/u);
    assert.match(sql, /essay_slot IS NOT NULL OR NOT EXISTS/u);
    assert.match(sql, /slotted\.source_record_id=legacy\.source_record_id/u);
    assert.match(sql, /excluded_ic_before_2065/u);
    return { rowCount: 1, rows: [{ legacy_id: 'legacy', essay_slot: 2,
      snapshot_ciphertext: seal(JSON.stringify(snapshot), Buffer.from(hexKey, 'hex')) }] };
  });
  const [row] = await createWritingFlowOperations({ pool, encryptionKey: hexKey })
    .listLegacyRecords({ limit: 1 });
  assert.equal(row.homework_title, 'Writing homework 12');
  assert.equal(row.topic, 'Đề giả');
  assert.equal(row.essay_preview, 'Nội dung bài giả');
  assert.equal(row.tr_cc_check, true);
  assert.equal(Object.hasOwn(row, 'snapshot_ciphertext'), false);
});

test('chỉ cấp lớp đã duyệt hợp lệ, gồm CS thiếu trạng thái nguồn, và giới hạn theo tham số', async () => {
  const classCodes = Array.from({ length: 8 }, (_, index) => `IC22${String(index).padStart(2, '0')}`);
  const statements = [];
  const pool = poolWith(async (sql, params) => {
    statements.push({ sql, params });
    if (sql.includes("SET scan_status='needs_review'")) return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT class_code FROM writing_flow.class_registry')) {
      return { rowCount: classCodes.length, rows: classCodes.map(class_code => ({ class_code })) };
    }
    if (sql.includes("SET scan_status='scanning'")) {
      return { rowCount: classCodes.length,
        rows: classCodes.map(class_code => ({ class_code, scan_attempt_count: 1 })) };
    }
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  });
  const rows = await createWritingFlowOperations({ pool }).claimDueClasses({ limit: 8 });
  assert.equal(rows.length, 8);
  assert.equal(statements[1].params[0], 8);
  assert.match(statements[1].sql, /mapping_status='approved'/u);
  assert.match(statements[1].sql, /eligibility_reason='active'/u);
  assert.doesNotMatch(statements[1].sql, /class_status='on_going'/u);
  assert.match(statements[1].sql, /8-count\(\*\).*scan_status='scanning'/su);
  assert.match(statements[1].sql, /FOR UPDATE SKIP LOCKED[\s\S]*LIMIT least\(\$1/u);
});

test('lớp lỗi lần ba vào Cần kiểm tra, lớp thành công về đúng ba mốc quét', async () => {
  const statements = [];
  const pool = poolWith(async (sql, params) => {
    statements.push({ sql, params });
    return { rowCount: 1, rows: [{ class_code: params[0],
      scan_status: params[1] === 'succeeded' ? 'succeeded' : 'needs_review' }] };
  });
  const operations = createWritingFlowOperations({ pool });
  assert.equal((await operations.acknowledgeClassScan({ classCode: 'IC2200',
    outcome: 'failed', errorCode: 'GOOGLE_RATE_LIMIT' })).scan_status, 'needs_review');
  assert.equal((await operations.acknowledgeClassScan({ classCode: 'IC2200',
    outcome: 'succeeded' })).scan_status, 'succeeded');
  assert.match(statements[0].sql, /scan_attempt_count>=3 THEN 'needs_review'/u);
  assert.match(statements[0].sql, /floor\(random\(\) \* 31\)/u);
  assert.match(statements[0].sql, /60 \* power\(2,/u);
  for (const time of ['05:00', '12:00', '17:00']) assert.equal(statements[1].sql.includes(time), true);
  assert.match(statements[1].sql, /Asia\/Ho_Chi_Minh/u);
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
  assert.equal(reset.params[3], 'critic');
  assert.deepEqual(reset.params[1], STAGES);
  assert.match(reset.sql,
    /error_code=CASE WHEN stage_key=\$4 THEN NULL ELSE 'UPSTREAM_RETRY_REQUESTED' END/u);
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

test('migration trạng thái lớp và tìm kiếm không cấp quyền ghi database mapping', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../../docs/migrations/2026-09-20-writing-flow-operations-v3.sql',
    import.meta.url), 'utf8');
  for (const column of ['mapping_status', 'class_status', 'eligibility_reason',
    'scan_attempt_count', 'last_mapping_sync_at']) assert.match(sql, new RegExp(column, 'u'));
  assert.match(sql, /CREATE OR REPLACE FUNCTION writing_flow\.normalize_search/u);
  assert.match(sql, /mapping\.classroom_course_mapping/u);
  assert.match(sql, /GRANT SELECT ON TABLE %s TO writing_practice_api/u);
  assert.doesNotMatch(sql, /GRANT\s+(?:INSERT|UPDATE|DELETE)[\s\S]*mapping\./iu);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/iu);
});

test('migration nhật ký cho phép ghi thay đổi mapping và có chỉ mục theo lớp', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../../docs/migrations/2026-09-20-writing-flow-operations-v4.sql',
    import.meta.url), 'utf8');
  assert.match(sql, /class_mapping_changed/u);
  assert.match(sql, /writing_operator_event_class_idx/u);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/iu);
});

test('migration dashboard tạo chỉ mục HMAC và không lưu nội dung rõ', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../../docs/migrations/2026-09-20-writing-flow-dashboard-fields-v5.sql',
    import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS writing_flow\.pair_search_token/u);
  assert.match(sql, /token_hash bytea/u);
  assert.match(sql, /writing_pair_search_token_lookup_idx/u);
  assert.match(sql, /display_name=coalesce/u);
  assert.doesNotMatch(sql, /essay_text|content_text|GRANT\s+DELETE/iu);
});

test('retry lớp dùng cùng eligibility đã duyệt nên nhận được lớp CS thiếu trạng thái nguồn', async () => {
  const statements = [];
  const pool = poolWith(async (sql, params) => {
    statements.push({ sql, params });
    if (sql.includes('FROM writing_flow.operator_event')) return { rowCount: 0, rows: [] };
    if (sql.includes('UPDATE writing_flow.class_registry')) {
      return { rowCount: 1, rows: [{ class_code: 'CS.070626' }] };
    }
    if (sql.includes('INSERT INTO writing_flow.operator_event')) return { rowCount: 1, rows: [] };
    throw new Error(`UNEXPECTED_SQL:${sql}`);
  });
  const result = await createWritingFlowOperations({ pool }).requestClassScan({
    classCode: 'CS.070626', requestId: 'request-cs-retry',
    actorRef: 'operator', reason: 'Kiểm tra lại lớp CS hợp lệ',
  });
  assert.equal(result.classCode, 'CS.070626');
  const update = statements.find(item => item.sql.includes('UPDATE writing_flow.class_registry'));
  assert.match(update.sql, /eligibility_reason='active'/u);
  assert.doesNotMatch(update.sql, /class_status='on_going'/u);
});

test('migration v6 tạo thùng rác mềm cho lỗi nguồn và nhật ký khôi phục', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL('../../docs/migrations/2026-09-21-writing-flow-class-filter-and-source-skip-v6.sql',
    import.meta.url), 'utf8');
  for (const field of ['skipped_at', 'skipped_by', 'skip_reason', 'source_issue_key']) {
    assert.match(sql, new RegExp(field, 'u'));
  }
  assert.match(sql, /source_issue_skipped/u);
  assert.match(sql, /source_issue_restored/u);
  assert.doesNotMatch(sql, /\bDELETE\s+FROM\b|GRANT\s+DELETE/iu);
});

test('migration v7 lưu lớp Classroom trực tiếp không cần ID ERP giả', async () => {
  const { readFile } = await import('node:fs/promises');
  const sql = await readFile(new URL(
    '../../docs/migrations/2026-09-21-writing-flow-direct-classroom-classes-v7.sql',
    import.meta.url), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS mapping\.classroom_direct_class/u);
  assert.match(sql, /class_code text PRIMARY KEY/u);
  assert.match(sql, /classroom_course_id text NOT NULL UNIQUE/u);
  assert.match(sql, /GRANT SELECT,INSERT,UPDATE[^;]+n8n_erp_sync/su);
  assert.match(sql, /GRANT SELECT[^;]+writing_practice_api/su);
  assert.doesNotMatch(sql, /GRANT DELETE/u);
});
