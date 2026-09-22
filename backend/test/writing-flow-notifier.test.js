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
