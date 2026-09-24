// Nhận vào: DATABASE_URL của Writing staging có một cặp giả đang xử lý.
// Việc chính: giả lập bước chấm hết hạn rồi gọi đúng hàm phục hồi của backend.
// Kết quả: một retry đúng bước được tạo trong transaction thử; rollback giữ dữ liệu gốc.
// Khi lỗi: in mã lỗi ngắn, không in mã cặp, nội dung bài hoặc thông tin kết nối.
import pg from 'pg';
import { createWritingFlowHandoff } from 'file:///app/src/writing-flow-handoff.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
let client;
let transactionOpen = false;
try {
  client = await pool.connect();
  const database = await client.query('SELECT current_database() AS name');
  if (!String(database.rows[0]?.name || '').endsWith('_staging')) {
    throw new Error('STAGING_DATABASE_REQUIRED');
  }
  await client.query('BEGIN');
  transactionOpen = true;
  const fixture = await client.query(`
    SELECT s.pair_id,s.stage_key,s.cycle_no,s.attempt_count,a.attempt_id
      FROM writing_flow.stage_result s
      JOIN writing_flow.pair p ON p.pair_id=s.pair_id
      JOIN writing_flow.stage_attempt a ON a.pair_id=s.pair_id
        AND a.stage_key=s.stage_key AND a.cycle_no=s.cycle_no
        AND a.attempt_no=s.attempt_count
     WHERE p.status='running' AND s.stage_key='main'
       AND s.status='succeeded' AND s.attempt_count=1 AND a.status='succeeded'
     LIMIT 1 FOR UPDATE OF s,a`);
  if (fixture.rowCount !== 1) throw new Error('STAGING_FIXTURE_MISSING');
  const row = fixture.rows[0];
  const before = await client.query(`SELECT count(*)::integer AS total
    FROM writing_flow.handoff WHERE pair_id=$1 AND from_stage='retry'
      AND to_stage='main'`, [row.pair_id]);

  await client.query(`UPDATE writing_flow.stage_result
    SET status='running',result_ciphertext=NULL,result_sha256=NULL,
        selected_attempt_no=NULL,lease_expires_at=now()-interval '1 minute'
    WHERE pair_id=$1 AND stage_key='main'`, [row.pair_id]);
  await client.query(`UPDATE writing_flow.stage_attempt
    SET status='sent',finished_at=NULL WHERE attempt_id=$1`, [row.attempt_id]);

  // Giữ toàn bộ lời gọi của hàm thật trên một kết nối/transaction ngoài.
  // SAVEPOINT thay transaction con để có thể rollback mọi thay đổi sau kiểm tra.
  const temporaryPool = {
    query(sql, params) { return client.query(sql, params); },
    async connect() {
      return {
        query(sql, params) {
          if (sql === 'BEGIN') return client.query('SAVEPOINT codex_lease_probe');
          if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT codex_lease_probe');
          if (sql === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT codex_lease_probe');
          return client.query(sql, params);
        },
        release() {},
      };
    },
  };
  const recovered = await createWritingFlowHandoff({ pool: temporaryPool }).recoverExpired(1);
  const stage = await client.query(`SELECT status FROM writing_flow.stage_result
    WHERE pair_id=$1 AND stage_key='main'`, [row.pair_id]);
  const attempt = await client.query(`SELECT status FROM writing_flow.stage_attempt
    WHERE attempt_id=$1`, [row.attempt_id]);
  const during = await client.query(`SELECT count(*)::integer AS total
    FROM writing_flow.handoff WHERE pair_id=$1 AND from_stage='retry'
      AND to_stage='main'`, [row.pair_id]);
  const recoveredRightStage = recovered.length === 1
    && recovered[0].stageKey === 'main' && recovered[0].status === 'retry_requested';
  const changedInsideTransaction = stage.rows[0]?.status === 'pending'
    && attempt.rows[0]?.status === 'unknown'
    && during.rows[0].total === before.rows[0].total + 1;

  await client.query('ROLLBACK');
  transactionOpen = false;
  const afterStage = await client.query(`SELECT status FROM writing_flow.stage_result
    WHERE pair_id=$1 AND stage_key='main'`, [row.pair_id]);
  const afterAttempt = await client.query(`SELECT status FROM writing_flow.stage_attempt
    WHERE attempt_id=$1`, [row.attempt_id]);
  const afterHandoffs = await client.query(`SELECT count(*)::integer AS total
    FROM writing_flow.handoff WHERE pair_id=$1 AND from_stage='retry'
      AND to_stage='main'`, [row.pair_id]);
  const restored = afterStage.rows[0]?.status === 'succeeded'
    && afterAttempt.rows[0]?.status === 'succeeded'
    && afterHandoffs.rows[0].total === before.rows[0].total;
  const ok = recoveredRightStage && changedInsideTransaction && restored;
  console.log(JSON.stringify({ ok, recoveredRightStage, changedInsideTransaction, restored }));
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false,
    errorCode: /^[A-Z0-9_]+$/u.test(String(error.code || '')) ? error.code
      : (/^[A-Z_]+$/u.test(error.message) ? error.message : 'LEASE_PROBE_FAILED') }));
  process.exitCode = 1;
} finally {
  if (transactionOpen) {
    try { await client.query('ROLLBACK'); } catch { /* Không để transaction mở. */ }
  }
  client?.release();
  await pool.end();
}
