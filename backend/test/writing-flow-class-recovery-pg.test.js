// Nhận vào: sổ lớp giả, có timeout thật và lớp khác vẫn đủ điều kiện quét.
// Kiểm SQL thật: hết ba lượt chỉ nghỉ đến kỳ kế tiếp, không bỏ bài mới nhiều năm.
// Các ca cũ chỉ kiểm chuỗi SQL nên không phát hiện lịch đóng băng 100 năm.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createWritingFlowOperations } from '../src/writing-flow-operations.js';

async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA writing_flow;
    CREATE TABLE writing_flow.class_registry (
      class_code text PRIMARY KEY,classroom_course_id text,classroom_name text,cohort text,
      teacher_names text[] DEFAULT '{}',enabled boolean DEFAULT true,
      mapping_status text DEFAULT 'approved',eligibility_reason text DEFAULT 'active',
      scan_status text DEFAULT 'pending',scan_attempt_count integer DEFAULT 0,
      next_scan_at timestamptz DEFAULT now(),last_scan_at timestamptz,
      last_error_code text,updated_at timestamptz DEFAULT now());
    INSERT INTO writing_flow.class_registry(class_code,scan_status,scan_attempt_count,next_scan_at)
      VALUES ('IC2197','scanning',3,now()-interval '1 minute'),('IC2205','pending',0,now());`);
  const client = { async query(...args) {
    const result = await db.query(...args);
    return { ...result,rowCount: result.rows.length || result.affectedRows || 0 };
  }, release() {} };
  return { db, ops: createWritingFlowOperations({ pool: { query: client.query,
    async connect() { return client; } } }) };
}

test('timeout ba lượt nghỉ dưới một ngày, lớp khác tiếp tục và kỳ sau thử lại từ lượt một', async () => {
  const { db, ops } = await fixture();
  try {
    const first = await ops.claimDueClasses({ limit: 8 });
    assert.deepEqual(first.map(r => r.class_code), ['IC2205']);
    const stopped = (await db.query(`SELECT *,extract(epoch FROM next_scan_at-now()) AS seconds
      FROM writing_flow.class_registry WHERE class_code='IC2197'`)).rows[0];
    assert.equal(stopped.scan_status, 'needs_review');
    assert.equal(stopped.last_error_code, 'CLASS_SCAN_TIMEOUT');
    assert.ok(Number(stopped.seconds) > 0 && Number(stopped.seconds) <= 24 * 3600,
      'Lớp phải được xét lại kỳ sau, không đóng băng 100 năm');
    await db.exec(`UPDATE writing_flow.class_registry SET next_scan_at=now()-interval '1 second'
      WHERE class_code='IC2197';`);
    const resumed = await ops.claimDueClasses({ limit: 8 });
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].class_code, 'IC2197');
    assert.equal(resumed[0].scan_attempt_count, 1);
  } finally { await db.close(); }
});

test('lỗi quyền và lớp đã hoàn thành không tự phục hồi; lớp khác không bị chặn', async () => {
  const { db, ops } = await fixture();
  try {
    await db.exec(`UPDATE writing_flow.class_registry SET scan_status='needs_review',
      last_error_code='GOOGLE_PERMISSION_DENIED' WHERE class_code='IC2197';
      INSERT INTO writing_flow.class_registry(class_code,enabled,scan_status,last_error_code)
      VALUES ('IC2195',false,'needs_review','CLASS_SCAN_TIMEOUT');`);
    const rows = await ops.claimDueClasses({ limit: 8 });
    assert.deepEqual(rows.map(r => r.class_code), ['IC2205']);
  } finally { await db.close(); }
});

test('xác nhận về sau khi lượt quét đã hết hạn không đổi sổ lớp', async () => {
  const { db, ops } = await fixture();
  try {
    await assert.rejects(ops.acknowledgeClassScan({ classCode: 'IC2197',outcome: 'succeeded' }),
      error => error.code === 'CLASS_SCAN_NOT_RUNNING');
    const row = (await db.query(`SELECT scan_status,scan_attempt_count FROM writing_flow.class_registry
      WHERE class_code='IC2197'`)).rows[0];
    assert.equal(row.scan_status,'scanning');
    assert.equal(row.scan_attempt_count,3);
  } finally { await db.close(); }
});
