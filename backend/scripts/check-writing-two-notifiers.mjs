// Nhận vào: DATABASE_URL của Writing staging có bàn giao giả đến hạn.
// Việc chính: chạy hai tiến trình Node riêng tranh cùng khóa PostgreSQL,
// rồi dừng bản chính và đánh thức bản dự phòng bằng đồng hồ giả.
// Kết quả: mỗi thời điểm chỉ một tiến trình gửi webhook giả; bản dự phòng tiếp quản.
// Khi lỗi: in mã ngắn, đóng cả hai tiến trình; không in bài viết hoặc kết nối.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import pg from 'pg';

const childCode = `
import pg from 'pg';
import { createWritingFlowNotifier } from 'file:///app/src/writing-flow-notifier.js';
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
let standbyHandler = null;
const notifier = createWritingFlowNotifier({ pool,
  handoffUrl: 'https://example.test/never-sent', secret: 'x'.repeat(32),
  fetchImpl: async () => {
    console.log(JSON.stringify({ event: 'signal' }));
    return { ok: true };
  },
  setRecurringTimer(handler, delay) {
    standbyHandler = handler;
    const timer = setInterval(handler, delay);
    timer.unref();
    return timer;
  },
  clearRecurringTimer(timer) { clearInterval(timer); },
  log() {} });
try {
  const leader = await notifier.start();
  console.log(JSON.stringify({ event: 'started', leader }));
  process.stdin.on('data', async chunk => {
    const command = String(chunk).trim();
    if (command === 'TAKEOVER') {
      if (!standbyHandler) throw new Error('STANDBY_TIMER_MISSING');
      standbyHandler();
    } else if (command === 'CLOSE') {
      await notifier.close();
      await pool.end();
      console.log(JSON.stringify({ event: 'closed' }));
      process.exit(0);
    }
  });
} catch {
  console.log(JSON.stringify({ event: 'failed' }));
  await notifier.close();
  await pool.end();
  process.exit(2);
}`;

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const processes = [];
function startChild() {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode],
    { stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
  const events = [];
  const waiters = [];
  readline.createInterface({ input: child.stdout }).on('line', line => {
    try {
      const event = JSON.parse(line);
      events.push(event);
      for (const waiter of waiters.splice(0)) waiter();
    } catch { /* Không đưa stdout bất thường vào báo cáo. */ }
  });
  const result = { child, events, waiters };
  processes.push(result);
  return result;
}
async function waitFor(instance, eventName, timeoutMs = 8_000) {
  const find = () => instance.events.find(item => item.event === eventName);
  if (find()) return find();
  await Promise.race([
    new Promise(resolve => instance.waiters.push(resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('WAIT_TIMEOUT')), timeoutMs)),
  ]);
  return find() || waitFor(instance, eventName, timeoutMs);
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

  const first = startChild();
  assert.equal((await waitFor(first, 'started')).leader, true);
  const second = startChild();
  assert.equal((await waitFor(second, 'started')).leader, false);
  await waitFor(first, 'signal');
  await new Promise(resolve => setTimeout(resolve, 2_300));
  assert.equal(second.events.filter(item => item.event === 'signal').length, 0);

  first.child.stdin.write('CLOSE\n');
  await waitFor(first, 'closed');
  second.child.stdin.write('TAKEOVER\n');
  await waitFor(second, 'signal');
  assert.equal(first.events.filter(item => item.event === 'signal').length, 1);
  assert.equal(second.events.filter(item => item.event === 'signal').length, 1);
  second.child.stdin.write('CLOSE\n');
  await waitFor(second, 'closed');
  console.log(JSON.stringify({ ok: true, processCount: 2,
    standbySilentBeforeTakeover: true, successorSentAfterTakeover: true,
    fakeWebhookCalls: 2, realWebhookCalls: 0 }));
} catch (error) {
  console.error(JSON.stringify({ ok: false,
    errorCode: /^[A-Z_]+$/u.test(String(error.message)) ? error.message
      : 'TWO_NOTIFIERS_PROBE_FAILED' }));
  process.exitCode = 1;
} finally {
  for (const instance of processes) {
    if (instance.child.exitCode === null) instance.child.kill();
  }
  await pool.end();
}
