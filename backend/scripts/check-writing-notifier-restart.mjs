// Nhận vào: DATABASE_URL của Writing staging có bàn giao giả đến hạn.
// Việc chính: tạo rồi đóng hai đời notifier với PostgreSQL thật và webhook giả.
// Kết quả: đời mới thấy lại việc tồn sau khi đời trước đã dừng, không gọi n8n thật.
// Khi lỗi: in mã lỗi ngắn; không in định danh bài hoặc thông tin kết nối.
import pg from 'pg';
import { createWritingFlowNotifier } from 'file:///app/src/writing-flow-notifier.js';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
const deliveredSignals = [];

function newNotifier(generation) {
  const timers = [];
  const notifier = createWritingFlowNotifier({ pool,
    handoffUrl: 'https://example.test/never-sent', secret: 'x'.repeat(32),
    fetchImpl: async () => {
      deliveredSignals.push(generation);
      return { ok: true };
    },
    setTimer(handler, delay) {
      const timer = { handler, delay, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    setRecurringTimer() { return { unref() {} }; },
    clearRecurringTimer() {},
    log() {} });
  return { notifier, timers };
}

try {
  const database = await pool.query('SELECT current_database() AS name');
  if (!String(database.rows[0]?.name || '').endsWith('_staging')) {
    throw new Error('STAGING_DATABASE_REQUIRED');
  }
  const due = await pool.query(`SELECT count(*)::integer AS total
    FROM writing_flow.handoff h JOIN writing_flow.pair p ON p.pair_id=h.pair_id
    WHERE h.status='pending' AND h.next_send_at<=now()
      AND p.status<>'superseded'`);
  if (due.rows[0].total < 1) throw new Error('DUE_FIXTURE_MISSING');

  for (const generation of [1, 2]) {
    const { notifier, timers } = newNotifier(generation);
    try {
      if (await notifier.start() !== true) throw new Error('LEADER_LOCK_NOT_ACQUIRED');
      const timer = timers.findLast(item => !item.cleared);
      if (!timer) throw new Error('STARTUP_PUMP_MISSING');
      await timer.handler();
    } finally {
      await notifier.close();
    }
  }
  const ok = deliveredSignals.length === 2
    && deliveredSignals[0] === 1 && deliveredSignals[1] === 2;
  console.log(JSON.stringify({ ok, dueFixtureCount: due.rows[0].total,
    fakeWebhookCalls: deliveredSignals.length, secondGenerationRecovered: ok }));
  if (!ok) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ ok: false,
    errorCode: /^[A-Z_]+$/u.test(error.message) ? error.message : 'NOTIFIER_RESTART_PROBE_FAILED' }));
  process.exitCode = 1;
} finally {
  await pool.end();
}
