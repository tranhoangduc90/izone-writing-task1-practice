import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowService } from '../src/writing-flow-service.js';
import { createWritingFlowOperations } from '../src/writing-flow-operations.js';
import { seal } from '../src/writing-flow-crypto.js';

test('thống kê ngày trả hợp đồng YYYY-MM-DD thay vì timestamp phụ thuộc driver', async () => {
  let observedSql = '';
  const pool = { query: async sql => { observedSql = sql; return { rows: [] }; } };
  await createWritingFlowService({ pool }).dailyStats();
  assert.match(observedSql, /to_char\([\s\S]*'YYYY-MM-DD'\)[\s\S]*AS day/iu);
});

test('độ phủ lớp bỏ mapping không thuộc phạm vi Writing trước khi lên dashboard', async () => {
  const pool = { query: async sql => {
    if (sql.includes('FROM mapping.classroom_course_mapping AS course')) return { rows: [
      { erp_course_class_id: 'demo', erp_class_name_snapshot: '[DEMO] PROGRESS LOG · KHÓA 56',
        classroom_course_id: 'demo-course', classroom_course_name_snapshot: 'Demo',
        classroom_section_snapshot: '', mapping_status: 'approved', class_statuses: ['on_going'],
        teacher_names: [] },
      { erp_course_class_id: 'one-to-one', erp_class_name_snapshot: 'IC1-1.20',
        classroom_course_id: 'one-to-one-course', classroom_course_name_snapshot: 'IC1-1.20',
        classroom_section_snapshot: 'Lớp 1-1', mapping_status: 'approved',
        class_statuses: ['on_going'], teacher_names: [] },
    ] };
    return { rows: [] };
  } };
  assert.deepEqual(await createWritingFlowService({ pool }).listClassCoverage(), []);
});

test('huy hiệu cần kiểm tra dùng cùng điều kiện với view và loại bài đã bỏ qua', async () => {
  const calls = [];
  const pool = { query: async sql => { calls.push(sql); return calls.length === 1
    ? { rows: [] } : { rows: [{ source_issues: 0, reviews: 0, technical_errors: 0 }] }; } };
  await createWritingFlowService({ pool }).dashboardCounts();
  const supportSql = calls[1];
  assert.match(supportSql, /pair\.skipped_at IS NULL/iu);
  assert.match(supportSql, /review_stage\.status='needs_review'/iu);
  assert.match(supportSql, /review_stage\.cycle_no=review\.cycle_no/iu);
});

test('popup dùng cờ TRCC cứu hộ và ghi rõ nguồn thay vì hiện Không', async () => {
  const key = Buffer.alloc(32, 9);
  const ciphertext = seal(JSON.stringify(['task_2', 'Đề thử', null, 'Bài thử', false]), key);
  let call = 0;
  const pool = { query: async sql => {
    call += 1;
    if (call === 1) return { rowCount: 1, rows: [{ pair_id: 'pair-demo',
      source_ciphertext: ciphertext, trcc_required_override: true,
      trcc_repair_status: 'succeeded' }] };
    assert.match(sql, /FROM writing_flow\.stage_result/iu);
    return { rows: [] };
  } };
  const detail = await createWritingFlowOperations({ pool, encryptionKey: key }).pairDetail({
    pairId: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(detail.source.trCcCheck, true);
  assert.equal(detail.source.trCcSource, 'repair_override');
  assert.equal(detail.source.trCcRepairStatus, 'succeeded');
});

test('sắp xếp dashboard chỉ dùng các biểu thức allowlist và thêm pair_id ổn định', async () => {
  let listSql = '';
  const pool = { query: async (sql) => { listSql = sql; return { rows: [] }; } };
  await createWritingFlowService({ pool }).listPairs({
    sort: 'finished:desc,student:asc', limit: 50,
  });
  assert.match(listSql, /ORDER BY coalesce\(p\.finished_at,deliver\.completed_at\) DESC NULLS LAST/iu);
  assert.match(listSql, /writing_flow\.normalize_search\(coalesce\(nullif\(s\.student_name,''\),s\.display_name,''\)\) ASC NULLS LAST/iu);
  assert.match(listSql, /p\.pair_id DESC/iu);
  assert.match(listSql, /\$16::timestamptz IS NULL AND \$17::uuid IS NULL/iu);
  assert.doesNotMatch(listSql, /finished:desc|student:asc/iu);
});

test('sắp xếp từ chối trường hoặc chiều không được phép', async () => {
  const service = createWritingFlowService({ pool: { query: async () => ({ rows: [] }) } });
  await assert.rejects(service.listPairs({ sort: 'source_ciphertext:asc' }),
    error => error.code === 'WRITING_SORT_INVALID');
  await assert.rejects(service.listPairs({ sort: 'finished:sideways' }),
    error => error.code === 'WRITING_SORT_INVALID');
});
