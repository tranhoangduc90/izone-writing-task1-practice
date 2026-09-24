// Nhận vào: DATABASE_URL của database Writing staging có bàn giao giả đang chờ.
// Việc chính: hai kết nối cùng xin khóa một bàn giao bằng SKIP LOCKED rồi rollback.
// Kết quả: chỉ kết nối đầu nhận việc; trạng thái bàn giao giữ nguyên để thử lại.
// Khi lỗi: in mã lỗi ngắn, không in định danh cặp hoặc dữ liệu học viên.
import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
let first;
let second;
try {
  first = await pool.connect();
  second = await pool.connect();
  const database = await first.query('SELECT current_database() AS name');
  if (!String(database.rows[0]?.name || '').endsWith('_staging')) {
    throw new Error('STAGING_DATABASE_REQUIRED');
  }
  const fixture = await first.query(`SELECT handoff_id FROM writing_flow.handoff
    WHERE status='pending' LIMIT 1`);
  if (fixture.rowCount !== 1) throw new Error('PENDING_FIXTURE_MISSING');
  const handoffId = fixture.rows[0].handoff_id;

  await first.query('BEGIN');
  await second.query('BEGIN');
  const sql = `SELECT handoff_id FROM writing_flow.handoff
    WHERE handoff_id=$1 AND status='pending' FOR UPDATE SKIP LOCKED`;
  const claimedFirst = await first.query(sql, [handoffId]);
  const claimedSecond = await second.query(sql, [handoffId]);
  await first.query('ROLLBACK');
  await second.query('ROLLBACK');
  const after = await first.query(`SELECT status FROM writing_flow.handoff
    WHERE handoff_id=$1`, [handoffId]);
  const preserved = after.rows[0]?.status === 'pending';
  const ok = claimedFirst.rowCount === 1 && claimedSecond.rowCount === 0 && preserved;
  console.log(JSON.stringify({ ok, firstClaimed: claimedFirst.rowCount,
    secondClaimed: claimedSecond.rowCount, preserved }));
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false,
    errorCode: /^[A-Z_]+$/u.test(error.message) ? error.message : 'CLAIM_LOCK_PROBE_FAILED' }));
  process.exitCode = 1;
} finally {
  if (first) {
    try { await first.query('ROLLBACK'); } catch { /* Không để transaction mở. */ }
    first.release();
  }
  if (second) {
    try { await second.query('ROLLBACK'); } catch { /* Không để transaction mở. */ }
    second.release();
  }
  await pool.end();
}
