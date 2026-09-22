// Chỉ chạy trên database staging. Script tạo một nguồn Classroom giả, gọi API thật,
// kiểm dấu vết loại nguồn. Nếu role API không có quyền DELETE, runner phát hành
// phải dọn fixture bằng role quản trị staging rồi đọc lại số fixture bằng 0.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const databaseUrl = process.env.DATABASE_URL;
const token = process.env.WRITING_FLOW_INTERNAL_TOKEN || process.env.INTERNAL_API_TOKEN;
const apiBase = process.env.WRITING_FLOW_API_BASE_URL || 'http://127.0.0.1:8790';
if (!databaseUrl || !token) throw new Error('STAGING_ENV_MISSING');
const databaseName = new URL(databaseUrl).pathname.replace(/^\//u, '');
if (databaseName !== 'writing_practice_staging') throw new Error('STAGING_DATABASE_REQUIRED');

const pool = new pg.Pool({ connectionString: databaseUrl });
const suffix = crypto.randomUUID();
const classCode = `TEST-${suffix.slice(0, 8)}`;
const courseId = `course-${suffix}`;
const submissionId = `submission-${suffix}`;
const docId = `document-${suffix}`;
const runId = crypto.randomUUID();
const itemKey = crypto.createHash('sha256').update(JSON.stringify([submissionId, docId, 1])).digest('hex');
try {
  await pool.query(`INSERT INTO writing_flow.class_registry
    (class_code,classroom_course_id,classroom_name,enabled,mapping_status,class_status,
     eligibility_reason,scan_status,next_scan_at)
    VALUES ($1,$2,$1,true,'approved','on_going','active','pending',now())`, [classCode, courseId]);
  const source = await pool.query(`INSERT INTO writing_flow.source_record
    (source_type,source_app_id,source_table_id,source_record_id,homework_file_id,
     source_link_index,display_name,class_code,file_url,source_updated_at,metadata,
     dispatch_status,next_dispatch_at)
    VALUES ('google_classroom','google_classroom',$1,$2,$3,1,'Reading practice',$4,
      'https://docs.google.com/document/d/example-document-id-12345/edit',now(),'{}','sent',now())
    RETURNING source_id`, [courseId, submissionId, docId, classCode]);
  await pool.query(`INSERT INTO writing_flow.scan_run
    (run_id,request_key,source_app_id,source_table_id,scanned_through_at,page_count,
     reached_end,status,item_count)
    VALUES ($1,$2,'google_classroom',$3,now(),1,true,'open',1)`,
  [runId, `staging:${suffix}`, courseId]);
  await pool.query(`INSERT INTO writing_flow.scan_item
    (run_id,item_key,source_record_id,homework_file_id,source_link_index,class_code,status)
    VALUES ($1,$2,$3,$4,1,$5,'pending')`,
  [runId, itemKey, submissionId, docId, classCode]);
  const response = await fetch(`${apiBase}/api/v1/internal/writing-flow/scans/acknowledge`, {
    method: 'POST', headers: { authorization: `Bearer ${token}`,
      'content-type': 'application/json' },
    body: JSON.stringify({ runId, itemKey, status: 'excluded', pairIds: [], issueKeys: [],
      detectedSlotCount: null, exclusionCode: 'NON_WRITING_DOCUMENT' }),
  });
  assert.equal(response.status, 200);
  const readback = await pool.query(`SELECT dispatch_status,last_error_code,
      metadata->'writingFilter'->>'version' AS version
    FROM writing_flow.source_record WHERE source_id=$1`, [source.rows[0].source_id]);
  assert.deepEqual(readback.rows[0], { dispatch_status: 'excluded',
    last_error_code: 'NON_WRITING_DOCUMENT', version: 'writing-source-title-v1' });
  const pairs = await pool.query('SELECT count(*)::integer AS count FROM writing_flow.pair WHERE source_id=$1',
    [source.rows[0].source_id]);
  assert.equal(pairs.rows[0].count, 0);
  process.stdout.write(`${JSON.stringify({ ok: true, sourceExcluded: true, pairCount: 0 })}\n`);
} finally {
  try {
    await pool.query('DELETE FROM writing_flow.scan_item WHERE run_id=$1', [runId]);
    await pool.query('DELETE FROM writing_flow.scan_run WHERE run_id=$1', [runId]);
    await pool.query('DELETE FROM writing_flow.source_record WHERE source_table_id=$1', [courseId]);
    await pool.query('DELETE FROM writing_flow.class_registry WHERE class_code=$1', [classCode]);
  } catch (error) {
    if (error?.code !== '42501') throw error;
    process.stdout.write(`${JSON.stringify({ cleanupRequired: true,
      marker: 'TEST-/staging:', reason: 'API_ROLE_HAS_NO_DELETE' })}\n`);
  }
  await pool.end();
}
