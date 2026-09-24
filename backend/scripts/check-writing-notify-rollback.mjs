// Nhận vào: DATABASE_URL của database staging Writing đã có ít nhất một cặp giả.
// Việc chính: ghi thử một bàn giao trong transaction rồi rollback, đồng thời nghe tín hiệu.
// Kết quả: in số tín hiệu và bản ghi còn lại; chỉ đạt khi đều bằng 0.
// Khi lỗi: dừng với mã lỗi ngắn; không in mã cặp, bài viết hoặc thông tin kết nối.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
let listener;
let writer;
let transactionOpen = false;
let privateMessages = 0;
let workMessages = 0;

try {
  listener = await pool.connect();
  writer = await pool.connect();
  const database = await writer.query('SELECT current_database() AS name');
  if (!String(database.rows[0]?.name || '').endsWith('_staging')) {
    throw new Error('STAGING_DATABASE_REQUIRED');
  }

  listener.on('notification', notification => {
    if (notification.channel === 'codex_rollback_probe') privateMessages += 1;
    if (notification.channel === 'writing_flow_work_ready') workMessages += 1;
  });
  await listener.query('LISTEN codex_rollback_probe');
  await listener.query('LISTEN writing_flow_work_ready');
  await writer.query("SELECT pg_notify('codex_rollback_probe','positive_control')");
  await new Promise(resolve => setTimeout(resolve, 300));
  if (privateMessages !== 1) throw new Error('LISTENER_CONTROL_FAILED');

  const pair = await writer.query('SELECT pair_id FROM writing_flow.pair LIMIT 1');
  if (pair.rowCount !== 1) throw new Error('STAGING_FIXTURE_MISSING');
  await writer.query('BEGIN');
  transactionOpen = true;
  const inserted = await writer.query(`
    INSERT INTO writing_flow.handoff
      (pair_id,from_stage,to_stage,source_result_sha256,next_send_at)
    VALUES ($1,'codex_rollback_probe','main',repeat(md5(gen_random_uuid()::text),2),now())
    RETURNING handoff_id`, [pair.rows[0].pair_id]);
  if (inserted.rowCount !== 1) throw new Error('STAGING_INSERT_FAILED');
  await writer.query('ROLLBACK');
  transactionOpen = false;

  await new Promise(resolve => setTimeout(resolve, 1300));
  const remaining = await writer.query(`SELECT count(*)::integer AS total
    FROM writing_flow.handoff WHERE from_stage='codex_rollback_probe'`);
  const remainingRows = remaining.rows[0].total;
  const ok = workMessages === 0 && remainingRows === 0;
  console.log(JSON.stringify({ ok, positiveControl: privateMessages,
    insertedThenRolledBack: 1, workNotifications: workMessages, remainingRows }));
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false,
    errorCode: /^[A-Z_]+$/u.test(error.message) ? error.message : 'ROLLBACK_PROBE_FAILED' }));
  process.exitCode = 1;
} finally {
  if (transactionOpen) {
    try { await writer.query('ROLLBACK'); } catch { /* Không để transaction mở. */ }
  }
  if (listener) {
    try { await listener.query('UNLISTEN *'); } catch { /* Kết nối đang đóng. */ }
    listener.release();
  }
  writer?.release();
  await pool.end();
}
