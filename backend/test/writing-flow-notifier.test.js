import test from 'node:test';
import assert from 'node:assert/strict';
import { createWritingFlowNotifier, WRITING_FLOW_FALLBACK_MS } from '../src/writing-flow-notifier.js';

function listenerPool(rows, { leader = true } = {}) {
  const listeners = new Map();
  const client = {
    async query(sql) {
      if (String(sql).includes('pg_try_advisory_lock')) return { rows: [{ acquired: leader }] };
      return { rows: [] };
    },
    on(name, handler) { listeners.set(name, handler); },
    release() {}
  };
  return {
    listeners,
    client,
    async connect() { return client; },
    async query() { return { rows: [rows.shift() || { handoff_due: false, source_due: false }] }; }
  };
}

test('tín hiệu sau commit đánh thức đúng hai workflow và không mang dữ liệu bài', async () => {
  const pool = listenerPool([{ handoff_due: true, source_due: true, next_at: null, server_now: new Date() }]);
  const calls = [];
  const timers = [];
  const notifier = createWritingFlowNotifier({ pool,
    handoffUrl: 'https://example.test/handoff', sourceUrl: 'https://example.test/source',
    secret: 's'.repeat(32), now: () => 10_000,
    setTimer(handler, delay) { timers.push({ handler, delay }); return timers.length; },
    clearTimer() {}, setRecurringTimer() { return 1; }, clearRecurringTimer() {},
    async fetchImpl(url, options) { calls.push({ url, options }); return { ok: true, body: { async cancel() {} } }; },
    log() {} });
  assert.equal(await notifier.start(), true);
  await timers.shift().handler();
  assert.deepEqual(calls.map(call => call.url).sort(),
    ['https://example.test/handoff', 'https://example.test/source']);
  assert.deepEqual(calls.map(call => JSON.parse(call.options.body).kind).sort(),
    ['writing_flow_handoff_ready', 'writing_flow_source_ready']);
  assert.ok(calls.every(call => call.options.headers.authorization === `Bearer ${'s'.repeat(32)}`));
  await notifier.close();
});

test('hàng trống không gọi n8n và giữ lịch phục hồi năm phút', async () => {
  const pool = listenerPool([{ handoff_due: false, source_due: false,
    next_at: null, server_now: new Date() }]);
  const recurring = [];
  let fetchCount = 0;
  const timers = [];
  const notifier = createWritingFlowNotifier({ pool,
    handoffUrl: 'https://example.test/handoff', secret: 's'.repeat(32),
    setTimer(handler, delay) { timers.push({ handler, delay }); return timers.length; },
    clearTimer() {}, setRecurringTimer(handler, delay) { recurring.push({ handler, delay }); return 1; },
    clearRecurringTimer() {}, async fetchImpl() { fetchCount += 1; }, log() {} });
  await notifier.start();
  await timers.shift().handler();
  assert.equal(fetchCount, 0);
  assert.equal(recurring[0].delay, WRITING_FLOW_FALLBACK_MS);
  await notifier.close();
});

test('chỉ một backend giữ vai trò điều phối và bản dự phòng thử nhận vai trò sau năm phút', async () => {
  const pool = listenerPool([], { leader: false });
  let scheduled = 0;
  const notifier = createWritingFlowNotifier({ pool,
    handoffUrl: 'https://example.test/handoff', secret: 's'.repeat(32),
    setTimer() { scheduled += 1; return 1; }, clearTimer() {},
    setRecurringTimer() { scheduled += 1; return 1; }, clearRecurringTimer() {}, log() {} });
  assert.equal(await notifier.start(), false);
  assert.equal(scheduled, 1);
  await notifier.close();
});

test('webhook lỗi không làm mất việc và hẹn thử lại 30 giây', async () => {
  const pool = listenerPool([{ handoff_due: true, source_due: false,
    next_at: null, server_now: new Date() }]);
  const timers = [];
  const notifier = createWritingFlowNotifier({ pool,
    handoffUrl: 'https://example.test/handoff', secret: 's'.repeat(32), now: () => 10_000,
    setTimer(handler, delay) { timers.push({ handler, delay }); return timers.length; },
    clearTimer() {}, setRecurringTimer() { return 1; }, clearRecurringTimer() {},
    async fetchImpl() { throw new Error('network'); }, log() {} });
  await notifier.start();
  await timers.shift().handler();
  assert.equal(timers.at(-1).delay, 30000);
  await notifier.close();
});

test('hai tín hiệu trùng được gộp thành một lượt đánh thức', async () => {
  const pool = listenerPool([{ handoff_due: true, source_due: false,
    next_at: null, server_now: new Date() }]);
  const timers = [];
  let sent = 0;
  const notifier = createWritingFlowNotifier({ pool,
    handoffUrl: 'https://example.test/handoff', secret: 's'.repeat(32),
    now: () => 10_000,
    setTimer(handler, delay) { const timer = { handler, delay }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    setRecurringTimer() { return 1; }, clearRecurringTimer() {},
    async fetchImpl() { sent += 1; return { ok: true }; }, log() {} });
  await notifier.start();
  pool.listeners.get('notification')();
  pool.listeners.get('notification')();
  assert.equal(timers.filter(timer => !timer.cleared).length, 1);
  await timers.findLast(timer => !timer.cleared).handler();
  assert.equal(sent, 1);
  await notifier.close();
});

test('đường gọi trực tiếp có hai giây nhận việc trước khi notifier đánh thức n8n', async () => {
  let directClaimed = false;
  const pool = listenerPool([]);
  pool.query = async () => ({ rows: [{ handoff_due: !directClaimed,
    source_due: false, next_at: null, server_now: new Date() }] });
  const timers = [];
  let sent = 0;
  const notifier = createWritingFlowNotifier({ pool,
    handoffUrl: 'https://example.test/handoff', secret: 's'.repeat(32),
    setTimer(handler, delay) { const timer = { handler, delay }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    setRecurringTimer() { return { unref() {} }; }, clearRecurringTimer() {},
    async fetchImpl() { sent += 1; return { ok: true }; }, log() {} });
  assert.equal(await notifier.start(), true);
  assert.ok(timers[0].delay >= 2_000);
  directClaimed = true;
  await timers[0].handler();
  assert.equal(sent, 0);
  await notifier.close();
});

test('nhiều tín hiệu liên tiếp không đẩy lùi mãi thời điểm đánh thức', async () => {
  const pool = listenerPool([{ handoff_due: true, source_due: false,
    next_at: null, server_now: new Date() }]);
  const timers = [];
  let sent = 0;
  const notifier = createWritingFlowNotifier({ pool,
    handoffUrl: 'https://example.test/handoff', secret: 's'.repeat(32),
    setTimer(handler, delay) { const timer = { handler, delay }; timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    setRecurringTimer() { return { unref() {} }; }, clearRecurringTimer() {},
    async fetchImpl() { sent += 1; return { ok: true }; }, log() {} });
  assert.equal(await notifier.start(), true);
  const firstTimer = timers[0];
  for (let index = 0; index < 100; index += 1) pool.listeners.get('notification')();
  assert.equal(firstTimer.cleared, undefined);
  assert.equal(timers.filter(timer => !timer.cleared).length, 1);
  await firstTimer.handler();
  assert.equal(sent, 1);
  await notifier.close();
});

for (const failure of ['http_500', 'timeout']) {
  test(`n8n ${failure} vẫn gửi lại tín hiệu khi việc còn trong database`, async () => {
    const rows = Array.from({ length: 2 }, () => ({ handoff_due: true,
      source_due: false, next_at: null, server_now: new Date() }));
    const pool = listenerPool(rows);
    const timers = [];
    let sent = 0;
    let currentTime = 10_000;
    const notifier = createWritingFlowNotifier({ pool,
      handoffUrl: 'https://example.test/handoff', secret: 's'.repeat(32),
      now: () => currentTime,
      setTimer(handler, delay) { const timer = { handler, delay }; timers.push(timer); return timer; },
      clearTimer(timer) { timer.cleared = true; },
      setRecurringTimer() { return 1; }, clearRecurringTimer() {},
      async fetchImpl() {
        sent += 1;
        if (sent === 1 && failure === 'timeout') throw new Error('timeout');
        if (sent === 1) return { ok: false, body: { async cancel() {} } };
        return { ok: true, body: { async cancel() {} } };
      },
      log() {} });
    assert.equal(await notifier.start(), true);
    await timers.shift().handler();
    assert.equal(sent, 1);
    assert.equal(timers.at(-1).delay, 30_000);
    currentTime += 30_000;
    await timers.at(-1).handler();
    assert.equal(sent, 2);
    await notifier.close();
  });
}

test('mất kết nối giữ khóa phải dừng gửi và hẹn thử nhận lại vai trò điều phối', async () => {
  const pool = listenerPool([{ handoff_due: true, source_due: false,
    next_at: null, server_now: new Date() }]);
  const timers = [];
  const recurring = [];
  let sent = 0;
  const notifier = createWritingFlowNotifier({ pool,
    handoffUrl: 'https://example.test/handoff', secret: 's'.repeat(32),
    now: () => 10_000,
    setTimer(handler, delay) { const timer = { handler, delay }; timers.push(timer); return timer; },
    clearTimer() {},
    setRecurringTimer(handler, delay) { const timer = { handler, delay }; recurring.push(timer); return timer; },
    clearRecurringTimer() {},
    async fetchImpl() { sent += 1; return { ok: true }; }, log() {} });
  assert.equal(await notifier.start(), true);
  const scheduledBeforeLoss = timers[0];
  pool.listeners.get('error')(new Error('database connection lost'));
  await scheduledBeforeLoss.handler();
  assert.equal(sent, 0);
  assert.ok(recurring.some(timer => timer.delay === WRITING_FLOW_FALLBACK_MS));
  await notifier.close();
});

test('database tạm ngắt lúc khởi động vẫn tự thử lại và nhận việc tồn', async () => {
  let connectCount = 0;
  const listeners = new Map();
  const client = {
    async query(sql) {
      if (String(sql).includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      return { rows: [] };
    },
    on(name, handler) { listeners.set(name, handler); }, release() {}
  };
  const pool = {
    async connect() {
      connectCount += 1;
      if (connectCount === 1) throw new Error('database unavailable');
      return client;
    },
    async query() { return { rows: [{ handoff_due: true, source_due: false,
      next_at: null, server_now: new Date() }] }; }
  };
  const timers = [];
  const recurring = [];
  let sent = 0;
  const notifier = createWritingFlowNotifier({ pool,
    handoffUrl: 'https://example.test/handoff', secret: 's'.repeat(32), now: () => 10_000,
    setTimer(handler, delay) { const timer = { handler, delay }; timers.push(timer); return timer; },
    clearTimer() {},
    setRecurringTimer(handler, delay) { const timer = { handler, delay }; recurring.push(timer); return timer; },
    clearRecurringTimer() {},
    async fetchImpl() { sent += 1; return { ok: true }; }, log() {} });
  assert.equal(await notifier.start(), false);
  assert.equal(recurring[0].delay, WRITING_FLOW_FALLBACK_MS);
  await recurring[0].handler();
  await new Promise(resolve => setImmediate(resolve));
  await timers.at(-1).handler();
  assert.equal(connectCount, 2);
  assert.equal(sent, 1);
  await notifier.close();
});

test('hai backend: bản dự phòng nhận khóa sau khi bản chính dừng và chỉ gửi một lần', async () => {
  let owner = null;
  const sent = [];
  const clock = name => ({
    timers: [], recurring: [],
    setTimer(handler, delay) { const timer = { handler, delay }; this.timers.push(timer); return timer; },
    clearTimer(timer) { timer.cleared = true; },
    setRecurringTimer(handler, delay) {
      const timer = { handler, delay }; this.recurring.push(timer); return timer;
    },
    clearRecurringTimer(timer) { timer.cleared = true; },
    async fetchImpl() { sent.push(name); return { ok: true }; }
  });
  function leaderPool(name) {
    const client = {
      async query(sql) {
        if (String(sql).includes('pg_try_advisory_lock')) {
          if (owner === null) owner = name;
          return { rows: [{ acquired: owner === name }] };
        }
        if (String(sql).includes('pg_advisory_unlock') && owner === name) owner = null;
        return { rows: [] };
      },
      on() {},
      release() { if (owner === name) owner = null; }
    };
    return {
      async connect() { return client; },
      async query() { return { rows: [{ handoff_due: true, source_due: false,
        next_at: null, server_now: new Date() }] }; }
    };
  }
  const firstClock = clock('first');
  const secondClock = clock('second');
  const options = { handoffUrl: 'https://example.test/handoff',
    secret: 's'.repeat(32), now: () => 10_000, log() {} };
  const first = createWritingFlowNotifier({ ...options, pool: leaderPool('first'),
    ...firstClock,
    setTimer: firstClock.setTimer.bind(firstClock), clearTimer: firstClock.clearTimer.bind(firstClock),
    setRecurringTimer: firstClock.setRecurringTimer.bind(firstClock),
    clearRecurringTimer: firstClock.clearRecurringTimer.bind(firstClock) });
  const second = createWritingFlowNotifier({ ...options, pool: leaderPool('second'),
    ...secondClock,
    setTimer: secondClock.setTimer.bind(secondClock), clearTimer: secondClock.clearTimer.bind(secondClock),
    setRecurringTimer: secondClock.setRecurringTimer.bind(secondClock),
    clearRecurringTimer: secondClock.clearRecurringTimer.bind(secondClock) });
  assert.equal(await first.start(), true);
  assert.equal(await second.start(), false);
  await firstClock.timers[0].handler();
  assert.deepEqual(sent, ['first']);
  await first.close();
  assert.equal(owner, null);
  await secondClock.recurring[0].handler();
  await new Promise(resolve => setImmediate(resolve));
  await secondClock.timers[0].handler();
  assert.deepEqual(sent, ['first', 'second']);
  await second.close();
});

test('mất NOTIFY được nhịp năm phút phục hồi mà không cần n8n chạy rỗng', async () => {
  const pool = listenerPool([
    { handoff_due: false, source_due: false, next_at: null, server_now: new Date() },
    { handoff_due: true, source_due: false, next_at: null, server_now: new Date() }
  ]);
  const timers = [];
  const recurring = [];
  let sent = 0;
  const notifier = createWritingFlowNotifier({ pool,
    handoffUrl: 'https://example.test/handoff', secret: 's'.repeat(32), now: () => 10_000,
    setTimer(handler, delay) { const timer = { handler, delay }; timers.push(timer); return timer; },
    clearTimer() {},
    setRecurringTimer(handler, delay) { const timer = { handler, delay }; recurring.push(timer); return timer; },
    clearRecurringTimer() {},
    async fetchImpl() { sent += 1; return { ok: true }; }, log() {} });
  await notifier.start();
  await timers.shift().handler();
  assert.equal(sent, 0);
  assert.equal(recurring[0].delay, WRITING_FLOW_FALLBACK_MS);
  recurring[0].handler();
  await timers.shift().handler();
  assert.equal(sent, 1);
  await notifier.close();
});
