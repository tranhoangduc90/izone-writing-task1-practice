import assert from 'node:assert/strict';
import test from 'node:test';
import { classCodeFromName, createWritingFlowService, documentIdFromSearch,
  mappingClassState, markMappingConflicts, mergeClassCoverage } from '../src/writing-flow-service.js';
import { seal } from '../src/writing-flow-crypto.js';

const reviewId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';

test('trạng thái lớp chỉ active khi mapping đã duyệt và lớp đang học', () => {
  const base = { erp_course_class_id: 1, erp_class_name_snapshot: 'IELTS IC2269',
    classroom_course_id: 'course-1', classroom_course_name_snapshot: 'IELTS IC2269',
    classroom_section_snapshot: 'Chuyên sâu (6.0 - 7.0)',
    mapping_status: 'approved', class_statuses: ['on_going'], teacher_names: ['GV thử'] };
  assert.equal(mappingClassState(base).operational_state, 'active');
  assert.equal(mappingClassState({ ...base, class_statuses: ['completed'] }).operational_state,
    'completed');
  assert.equal(mappingClassState({ ...base, mapping_status: 'pending_review' }).operational_state,
    'pending_review');
  assert.equal(mappingClassState({ ...base, class_statuses: [] }).operational_state,
    'status_review');
  assert.equal(mappingClassState({ ...base, erp_class_name_snapshot: 'IC2288' }).operational_state,
    'excluded');
});

test('lớp của giảng viên Hoàng Diệu Pháp bị loại riêng khỏi hệ thống Writing', () => {
  const base = { erp_course_class_id: 2328, erp_class_name_snapshot: 'IC2328',
    classroom_course_id: 'course-2328', classroom_course_name_snapshot: 'IC2328',
    classroom_section_snapshot: 'Chiến lược (5.0 - 6.0)',
    mapping_status: 'approved', class_statuses: ['on_going'] };
  for (const teacherName of ['Hoàng Diệu Pháp', '  HOANG   DIEU PHAP  ']) {
    const result = mappingClassState({ ...base, teacher_names: [teacherName] });
    assert.equal(result.operational_state, 'excluded');
    assert.equal(result.eligibility_reason, 'excluded_teacher');
    assert.equal(result.enabled, false);
  }
  const otherTeacher = mappingClassState({ ...base, teacher_names: ['Giảng viên khác'] });
  assert.equal(otherTeacher.operational_state, 'active');
  assert.equal(otherTeacher.enabled, true);
  const futureClass = mappingClassState({ ...base, erp_class_name_snapshot: 'IC2400',
    teacher_names: ['Hoàng Diệu Pháp'] });
  assert.equal(futureClass.eligibility_reason, 'excluded_teacher');
});

test('danh sách và số đếm lỗi nguồn đều ẩn lớp đã loại theo giảng viên', async () => {
  const calls = [];
  const pool = { query: async (sql, values = []) => {
    calls.push({ sql, values });
    return { rows: [] };
  } };
  const service = createWritingFlowService({ pool });
  await service.listSourceIssues();
  assert.match(calls.at(-1).sql, /'excluded_teacher'/u);
  await service.dashboardCounts();
  const issueQueries = calls.filter(call => call.sql.includes('writing_flow.source_issue'));
  assert.ok(issueQueries.length >= 2);
  assert.equal(issueQueries.every(call => call.sql.includes("'excluded_teacher'")), true);
});

test('lọc lớp IC theo số hiệu, giữ hai hệ Writing, lớp 1-1 và mọi lớp CS', () => {
  const base = { erp_course_class_id: 1, classroom_course_id: 'course-1',
    classroom_course_name_snapshot: 'Classroom thử', mapping_status: 'approved',
    class_statuses: ['on_going'], teacher_names: [] };
  const beforeCutoff = mappingClassState({ ...base, erp_class_name_snapshot: 'IC2064',
    classroom_section_snapshot: 'Chuyên sâu (6.0 - 7.0)' });
  assert.equal(beforeCutoff.operational_state, 'excluded');
  assert.equal(beforeCutoff.eligibility_reason, 'excluded_ic_before_2065');
  for (const classInfo of ['Chuyên sâu (6.0 - 7.0)', 'Chiến lược (5.0 - 6.0)', 'Lớp 1-1']) {
    const accepted = mappingClassState({ ...base, erp_class_name_snapshot: 'IC2065',
      classroom_section_snapshot: `  ${classInfo}  ` });
    assert.equal(accepted.operational_state, 'active');
    assert.equal(accepted.class_info, classInfo);
  }
  const wrongProgram = mappingClassState({ ...base, erp_class_name_snapshot: 'IC2172',
    classroom_section_snapshot: 'IELTS Foundation' });
  assert.equal(wrongProgram.operational_state, 'excluded');
  assert.equal(wrongProgram.eligibility_reason, 'excluded_ic_program');
  const missingCourse = mappingClassState({ ...base, erp_class_name_snapshot: 'IC2172',
    classroom_course_id: null, classroom_section_snapshot: 'Chuyên sâu (6.0 - 7.0)' });
  assert.equal(missingCourse.operational_state, 'missing_classroom_course');
  const nonIc = mappingClassState({ ...base, erp_class_name_snapshot: 'CS.070626',
    classroom_section_snapshot: 'Hệ khác' });
  assert.equal(nonIc.operational_state, 'active');
  const csWithoutSourceStatus = mappingClassState({ ...base,
    erp_class_name_snapshot: 'CS.160826', classroom_section_snapshot: 'SW chuyên sâu',
    class_statuses: [] });
  assert.equal(csWithoutSourceStatus.operational_state, 'active');
  assert.equal(csWithoutSourceStatus.class_status, 'unknown');
});

test('bốn lớp Term test giữ nguyên tên làm mã và ghép Classroom không cần ID ERP', () => {
  const classNames = [
    'Term test 2 khóa Chuyên sâu',
    'Term test 2 khóa Chiến lược',
    'Term test 1 khóa Chuyên sâu',
    'Term test 1 khóa Chiến lược',
  ];
  for (const className of classNames) {
    assert.equal(classCodeFromName(`  ${className.toLocaleUpperCase('vi')}  `), className);
    const state = mappingClassState({
      erp_course_class_id: null,
      erp_class_name_snapshot: className,
      classroom_course_id: `course-${className}`,
      classroom_course_name_snapshot: className,
      classroom_section_snapshot: '',
      mapping_status: 'approved',
      class_statuses: ['on_going'],
      teacher_names: [],
      source_ref: `classroom_direct:${className}`,
    });
    assert.equal(state.operational_state, 'active');
    assert.equal(state.class_code, className);
    assert.equal(state.erp_course_class_id, null);
    assert.equal(state.source_ref, `classroom_direct:${className}`);
  }
});

test('mapping trùng mã lớp hoặc Classroom bị dừng để kiểm tra', () => {
  const rows = markMappingConflicts([
    { class_code: 'IC2200', classroom_course_id: 'course-a', operational_state: 'active', enabled: true },
    { class_code: 'IC2200', classroom_course_id: 'course-b', operational_state: 'active', enabled: true },
    { class_code: 'IC2201', classroom_course_id: 'course-c', operational_state: 'active', enabled: true },
    { class_code: 'IC2202', classroom_course_id: 'course-c', operational_state: 'active', enabled: true },
  ]);
  assert.equal(rows.every(row => row.operational_state === 'mapping_conflict'), true);
  assert.equal(rows.every(row => row.enabled === false), true);
});

test('tìm kiếm nhận URL Docs, Docs ID và không đoán chuỗi ngắn', () => {
  const id = '1BIb2pqpoe-j_5GzLfY5UXzdJzQ1JWQQVKU6FjRcyORs';
  assert.equal(documentIdFromSearch(`https://docs.google.com/document/d/${id}/edit`), id);
  assert.equal(documentIdFromSearch(id), id);
  assert.equal(documentIdFromSearch('Nguyễn Văn A'), null);
});

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
  assert.match(writes[0].sql, /status='skipped'[\s\S]*THEN 'skipped'/u);
});

test('lỗi nguồn có thùng rác mềm idempotent và khôi phục được', async () => {
  const issueKey = 'a'.repeat(64);
  const state = { status: 'open', events: new Set(), updates: [] };
  const client = { async query(sql, values = []) {
    if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
    if (sql.includes('SELECT event_type FROM writing_flow.operator_event')) {
      return { rowCount: state.events.has(values[0]) ? 1 : 0,
        rows: state.events.has(values[0]) ? [{ event_type: 'source_issue_skipped' }] : [] };
    }
    if (sql.includes('SELECT i.issue_key,i.status')) return { rowCount: 1,
      rows: [{ issue_key: issueKey, status: state.status, class_code: 'IC2172', source_id: null }] };
    if (sql.includes("SET status='skipped'")) { state.status = 'skipped'; state.updates.push('skipped'); }
    if (sql.includes("SET status='open'")) { state.status = 'open'; state.updates.push('open'); }
    if (sql.includes('INSERT INTO writing_flow.operator_event')) state.events.add(values[4]);
    return { rowCount: 1, rows: [] };
  }, release() {} };
  const service = createWritingFlowService({ pool: { connect: async () => client } });
  const first = await service.skipSourceIssue({ issueKey, requestId,
    actorRef: 'admin@example.invalid', reason: 'Không phải bài Writing' });
  assert.equal(first.status, 'skipped');
  const duplicate = await service.skipSourceIssue({ issueKey, requestId,
    actorRef: 'admin@example.invalid', reason: 'Không phải bài Writing' });
  assert.equal(duplicate.status, 'skipped');
  assert.deepEqual(state.updates, ['skipped']);
  const restored = await service.restoreSourceIssue({ issueKey,
    requestId: '44444444-4444-4444-8444-444444444444',
    actorRef: 'admin@example.invalid', reason: 'Bỏ qua nhầm' });
  assert.equal(restored.status, 'open');
  assert.deepEqual(state.updates, ['skipped', 'open']);
});

test('khôi phục mục tự bỏ qua sẽ xếp file đọc lại, không động vào bài đã chấm', async () => {
  const issueKey = 'b'.repeat(64);
  const calls = [];
  const client = { async query(sql, values = []) {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return {};
    calls.push({ sql, values });
    if (sql.includes('SELECT event_type FROM writing_flow.operator_event')) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes('SELECT i.issue_key,i.status')) return { rowCount: 1,
      rows: [{ issue_key: issueKey, status: 'skipped', class_code: 'IC2305',
        reason_code: 'ESSAY_ANCHOR_MISSING', skipped_by: 'system',
        source_id: '11111111-1111-4111-8111-111111111111' }] };
    return { rowCount: 1, rows: [] };
  }, release() {} };
  const service = createWritingFlowService({ pool: { connect: async () => client } });
  const result = await service.restoreSourceIssue({ issueKey,
    requestId: '55555555-5555-4555-8555-555555555555',
    actorRef: 'admin@example.invalid', reason: 'File đã sửa' });
  assert.equal(result.recheckQueued, true);
  const sourceUpdate = calls.find(call => call.sql.includes('UPDATE writing_flow.source_record'));
  assert.ok(sourceUpdate);
  assert.match(sourceUpdate.sql, /dispatch_status='pending'/u);
  assert.match(sourceUpdate.sql, /last_error_code='ESSAY_ANCHOR_MISSING'/u);
  assert.ok(calls.every(call => !call.sql.includes('UPDATE writing_flow.pair')));
});

test('danh sách lỗi nguồn tách trạng thái mở và đã bỏ qua', async () => {
  let observed;
  const pool = { query: async (sql, values) => { observed = { sql, values }; return { rows: [] }; } };
  await createWritingFlowService({ pool }).listSourceIssues({ status: 'skipped', limit: 25, offset: 5 });
  assert.match(observed.sql, /WHERE i\.status=\$6/u);
  assert.deepEqual(observed.values.slice(5), ['skipped', 25, 5]);
});

test('nhật ký một bài chỉ đọc metadata và sắp theo thời gian', async () => {
  const sqlSeen = [];
  const pairId = '33333333-3333-4333-8333-333333333333';
  const pool = { query: async sql => {
    sqlSeen.push(sql);
    if (sql.includes('FROM writing_flow.pair AS p LEFT JOIN')) return {
      rowCount: 1, rows: [{ pair_id: pairId, status: 'running' }] };
    if (sql.includes('FROM writing_flow.stage_result WHERE')) return {
      rows: [{ stage_key: 'main', status: 'running', updated_at: '2026-09-18T10:02:00Z' }] };
    if (sql.includes('FROM writing_flow.stage_attempt WHERE')) return {
      rows: [{ stage_key: 'main', attempt_no: 1, status: 'failed',
        started_at: '2026-09-18T10:01:00Z', finished_at: '2026-09-18T10:03:00Z' }] };
    return { rows: [] };
  } };
  const history = await createWritingFlowService({ pool }).pairHistory({ pairId });
  assert.deepEqual(history.events.map(row => row.kind), ['stage', 'attempt']);
  assert.equal(sqlSeen.length, 7);
  assert.equal(sqlSeen.every(sql => !/ciphertext|prompt|source_text|essay_text/i.test(sql)), true);
});

test('lỗi workflow được lưu theo một execution và không nhận stack', async () => {
  const seen = [];
  const pool = { query: async (sql, values) => {
    seen.push({ sql, values });
    return { rows: [{ failure_id: 'id', execution_id: values[2], seen_count: 1 }] };
  } };
  const receipt = await createWritingFlowService({ pool }).recordWorkflowFailure({
    workflowId: 'workflow-demo', workflowName: 'Chấm chính một bài',
    executionId: '123', lastNode: 'Gọi AI', errorKind: 'NodeOperationError',
    stack: 'KHÔNG LƯU NỘI DUNG RIÊNG',
  });
  assert.equal(receipt.execution_id, '123');
  assert.equal(seen[0].sql.includes('ON CONFLICT (workflow_id,execution_id)'), true);
  assert.equal(seen[0].values.includes('KHÔNG LƯU NỘI DUNG RIÊNG'), false);
});

test('đối chiếu lớp giữ đủ lớp thiếu, lớp lạ, lớp bị loại và tên không có mã', () => {
  assert.equal(classCodeFromName('IELTS 56 - IC 2269'), 'IC2269');
  assert.equal(classCodeFromName('CS 070626'), 'CS.070626');
  const rows = mergeClassCoverage([
    { class_name: 'IELTS IC2269', erp_source_found: true, classroom_source_found: true },
    { class_name: 'IELTS IC2270', erp_source_found: true, classroom_source_found: true },
    { class_name: 'IELTS IC2288', erp_source_found: true, classroom_source_found: true },
    { class_name: 'Lớp chưa đặt mã', erp_source_found: true, classroom_source_found: true },
  ], [
    { class_code: 'IC2269', last_scanned_at: '2026-09-19T08:00:00Z' },
    { class_code: 'IC2288', last_scanned_at: '2026-09-19T08:00:00Z' },
    { class_code: 'IC2299', last_scanned_at: '2026-09-19T08:00:00Z' },
  ]);
  assert.deepEqual(Object.fromEntries(rows.map(row => [row.class_code || row.class_name, row.status])), {
    IC2270: 'missing_source',
    'Lớp chưa đặt mã': 'class_code_missing',
    IC2299: 'unexpected_source',
    IC2288: 'excluded',
    IC2269: 'covered',
  });
});

test('dịch vụ chỉ đọc sổ lớp của hệ thống mới và mốc quét Classroom', async () => {
  const calls = [];
  const pool = { query: async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('FROM mapping.classroom_course_mapping AS course')) return { rows: [{
      erp_course_class_id: 'class:1', erp_class_name_snapshot: 'IELTS IC2269',
      classroom_course_id: 'course-1', classroom_course_name_snapshot: 'IELTS IC2269',
      classroom_section_snapshot: 'Chiến lược (5.0 - 6.0)',
      mapping_status: 'approved', class_statuses: ['on_going'], teacher_names: [],
    }] };
    return { rows: [{ class_code: 'IC2269', last_scanned_at: '2026-09-19T08:00:00Z' }] };
  } };
  const rows = await createWritingFlowService({ pool }).listClassCoverage();
  assert.equal(rows[0].status, 'covered');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[1].values, []);
  assert.equal(calls[0].sql.includes('mapping.classroom_course_mapping'), true);
  assert.equal(calls[0].sql.includes('mapping.classroom_direct_class'), true);
  assert.equal(calls[1].sql.includes('writing_flow.class_registry'), true);
  assert.equal(calls.every(call => !call.sql.includes('lark_export_teacher_assignments')), true);
  assert.equal(calls.every(call => !/student|essay|ciphertext|token/iu.test(call.sql)), true);
});

test('nhật ký thao tác toàn hệ thống lọc theo lớp và không đọc nội dung bài', async () => {
  let seen;
  const pool = { query: async (sql, params) => {
    seen = { sql, params };
    return { rows: [{ event_id: 'event-demo', event_type: 'class_mapping_changed',
      class_code: 'IC2200', reason: 'Đồng bộ trạng thái lớp' }] };
  } };
  const rows = await createWritingFlowService({ pool }).listOperatorEvents({
    classCode: 'IC2200', eventType: 'class_mapping_changed', limit: 25, offset: 0,
  });
  assert.equal(rows[0].class_code, 'IC2200');
  assert.deepEqual(seen.params, ['IC2200', 'class_mapping_changed', 25, 0]);
  assert.match(seen.sql, /writing_flow\.operator_event/u);
  assert.doesNotMatch(seen.sql, /source_ciphertext|result_ciphertext|essay_text/iu);
});

test('thống kê giảng viên đọc trực tiếp database mapping và lọc ngay trong database', async () => {
  const calls = [];
  const pool = { query: async (sql, values = []) => {
    calls.push({ sql, values });
    return { rows: [] };
  } };
  const service = createWritingFlowService({ pool });
  await service.summary();
  await service.listPairs({ classCode: 'IC2200', teacherName: 'Giảng viên thử',
    limit: 50, offset: 10 });
  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => call.sql.includes('mapping.classroom_course_mapping')), true);
  assert.equal(calls.every(call => call.sql.includes("account.status='active'")), true);
  assert.equal(calls.every(call => !call.sql.includes('lark_export_teacher_assignments')), true);
  assert.equal(calls.every(call => !/\b(?:INSERT|UPDATE|DELETE)\b/iu.test(call.sql)), true);
  assert.equal(calls.every(call => !/USING \(class_code\)/u.test(call.sql)), true);
  assert.deepEqual(calls[1].values, ['IC2200', 'Giảng viên thử',
    ['intake', 'precheck', 'main', 'critic', 'arbiter', 'render', 'deliver'],
    null, null, null, false, null, null, true, null, true, [], null, null, null, null, 50, 10,
    null]);
});

test('dashboard không còn phụ thuộc view phân công Lark', async () => {
  const calls = [];
  const pool = { query: async (sql, values = []) => {
    calls.push({ sql, values });
    return { rows: [] };
  } };
  const service = createWritingFlowService({ pool });
  await service.summary();
  await service.listPairs({ teacherName: 'Không có trong staging' });
  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => call.sql.includes('mapping.reviewer_class_access')), true);
  assert.equal(calls.every(call => !call.sql.includes('lark_export_teacher_assignments')), true);
});

test('bài kiểm thử giả không xuất hiện trong danh sách và số liệu vận hành', async () => {
  const calls = [];
  const pool = { query: async (sql, values = []) => {
    calls.push({ sql, values });
    return { rows: [] };
  } };
  const service = createWritingFlowService({ pool });
  await service.summary();
  await service.dashboardCounts({ sourceKind: 'test' });
  await service.dailyStats({ sourceKind: 'test' });
  await service.listPairs({ sourceKind: 'test' });
  await service.listReviews();
  await service.listSourceIssues();
  assert.equal(calls.length, 7);
  for (const { sql } of calls) {
    assert.match(sql, /IS DISTINCT FROM 'codex_fixture'/u);
  }
  assert.equal((calls[1].sql.match(/IS DISTINCT FROM 'codex_fixture'/gu) || []).length, 1);
  assert.equal((calls[2].sql.match(/IS DISTINCT FROM 'codex_fixture'/gu) || []).length, 2);
  assert.equal((calls[3].sql.match(/IS DISTINCT FROM 'codex_fixture'/gu) || []).length, 3);
});

test('mọi tab dashboard giải mã đúng khóa hex như production và trả đủ dữ liệu hiển thị', async () => {
  const encryptionKey = Buffer.alloc(32, 7).toString('hex');
  const binaryKey = Buffer.from(encryptionKey, 'hex');
  const sourceCiphertext = seal(JSON.stringify([
    'task_1', 'Đề bài thử', 'https://example.invalid/chart.png', 'Bài viết thử', true,
  ]), binaryKey);
  const resultUrl = `https://ducizone.ddns.net/writing/shared/writing-essays/${'a'.repeat(48)}/view?v=2`;
  const renderCiphertext = seal(JSON.stringify({ resultUrl }), binaryKey);
  const pool = { query: async () => ({ rows: [{
    pair_id: '11111111-1111-4111-8111-111111111111',
    source_ciphertext: sourceCiphertext, render_result_ciphertext: renderCiphertext,
  }] }) };
  const rows = await createWritingFlowService({ pool, encryptionKey }).listPairs({ limit: 1 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].topic, 'Đề bài thử');
  assert.equal(rows[0].image_url, 'https://example.invalid/chart.png');
  assert.equal(rows[0].tr_cc_check, true);
  assert.equal(rows[0].essay_preview, 'Bài viết thử');
  assert.equal(rows[0].lms_url, resultUrl);
  assert.equal(rows[0].data_issue_code, null);
  assert.equal(Object.hasOwn(rows[0], 'source_ciphertext'), false);
  assert.equal(Object.hasOwn(rows[0], 'render_result_ciphertext'), false);
});

test('Test đã khôi phục kết quả cũ không hiện link LMS và điểm của lượt chấm sai', async () => {
  const encryptionKey = Buffer.alloc(32, 7).toString('hex');
  const binaryKey = Buffer.from(encryptionKey, 'hex');
  const resultUrl = `https://ducizone.ddns.net/writing/shared/writing-essays/${'b'.repeat(48)}/view?v=1`;
  const pool = { query: async sql => {
    assert.match(sql, /test_pair\.historical_evidence/u);
    return { rows: [{
      pair_id: '11111111-1111-4111-8111-111111111111',
      source_type: 'term_test', task_score: 5.0, writing_score: 5.0,
      historical_evidence: { source: 'restored_legacy_result' },
      render_result_ciphertext: seal(JSON.stringify({ resultUrl }), binaryKey),
    }] };
  } };
  const [row] = await createWritingFlowService({ pool, encryptionKey }).listPairs({ limit: 1 });
  assert.equal(row.lms_url, null);
  assert.equal(row.task_score, null);
  assert.equal(row.writing_score, null);
  assert.equal(row.result_origin, 'legacy_restored');
  assert.equal(Object.hasOwn(row, 'historical_evidence'), false);
});

test('dòng lỗi giải mã được đánh dấu rõ thay vì âm thầm hiện ô trống', async () => {
  const encryptionKey = Buffer.alloc(32, 8).toString('hex');
  const pool = { query: async () => ({ rows: [{ pair_id: 'pair-bad',
    source_ciphertext: Buffer.from('khong-hop-le') }] }) };
  const [row] = await createWritingFlowService({ pool, encryptionKey }).listPairs({ limit: 1 });
  assert.equal(row.data_issue_code, 'SOURCE_DECRYPT_FAILED');
  assert.equal(row.topic, null);
});

test('số đếm dashboard ghi rõ bảng lớp khi pair và source cùng có class_code', async () => {
  const calls = [];
  const pool = { query: async (sql, values = []) => {
    calls.push({ sql, values });
    if (/USING \(class_code\)/u.test(sql)) {
      const error = new Error('column reference "class_code" is ambiguous');
      error.code = '42702';
      throw error;
    }
    if (sql.includes('AS source_issues')) {
      return { rows: [{ source_issues: 0, reviews: 0, technical_errors: 0 }] };
    }
    return { rows: [] };
  } };
  const result = await createWritingFlowService({ pool }).dashboardCounts();
  assert.deepEqual(result.support, { source_issues: 0, reviews: 0, technical_errors: 0 });
  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => !/USING \(class_code\)/u.test(call.sql)), true);
  assert.match(calls[1].sql,
    /teacher_assignments AS teachers ON teachers\.class_code=pair\.class_code/u);
  assert.match(calls[1].sql,
    /registry\.class_status IS DISTINCT FROM 'completed'[\s\S]*AS source_issues/u);
});

test('mọi bảng dashboard nối lớp bằng tên bảng rõ ràng để PostgreSQL không hiểu mơ hồ', async () => {
  const calls = [];
  const pool = { query: async (sql, values = []) => {
    calls.push({ sql, values });
    if (/USING \(class_code\)/u.test(sql)) {
      const error = new Error('common column name "class_code" appears more than once');
      error.code = '42702';
      throw error;
    }
    return { rows: [] };
  } };
  const service = createWritingFlowService({ pool });
  await service.dailyStats();
  await service.listReviews();
  assert.equal(calls.length, 2);
  assert.equal(calls.every(call => !/USING \(class_code\)/u.test(call.sql)), true);
  assert.match(calls[1].sql,
    /class_registry AS registry ON registry\.class_code=p\.class_code/u);
});
