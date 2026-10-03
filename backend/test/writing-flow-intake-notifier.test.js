import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createWritingFlowNotifier, writingFlowWorkStatusSql } from '../src/writing-flow-notifier.js';

test('nguồn mới đánh thức luồng tiếp nhận, không gọi nhầm luồng gửi Reader', async () => {
  const urls = [];
  const listener = {
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: true }] };
      return { rows: [] };
    },
    on() {}, release() {}
  };
  const notifier = createWritingFlowNotifier({
    pool: {
      async connect() { return listener; },
      async query() {
        return { rows: [{ handoff_due: false, source_due: false, intake_due: true,
          receipt_pending: false, next_at: null, server_now: new Date() }] };
      }
    },
    handoffUrl: 'https://example.test/handoff',
    sourceUrl: 'https://example.test/reader-queue',
    intakeUrl: 'https://example.test/intake',
    secret: 's'.repeat(32),
    now: () => 20_000,
    fetchImpl: async (url) => {
      urls.push(url);
      return { ok: true, status: 200, body: { async cancel() {} } };
    },
    setTimer: () => ({ unref() {} }), clearTimer() {},
    setRecurringTimer: () => ({ unref() {} }), clearRecurringTimer() {}, log() {}
  });
  await notifier.start();
  await notifier.pump();
  assert.deepEqual(urls, ['https://example.test/intake']);
  assert.match(writingFlowWorkStatusSql, /AS intake_due/);
  assert.match(writingFlowWorkStatusSql, /AS source_due/);
  await notifier.close();
});

test('SQL phân biệt nguồn chờ tiếp nhận với file đã có sổ quét', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA writing_flow;
      CREATE TABLE writing_flow.pair (pair_id int, status text);
      CREATE TABLE writing_flow.handoff (pair_id int, status text,
        next_send_at timestamptz, last_sent_at timestamptz);
      CREATE TABLE writing_flow.stage_result (pair_id int, status text,
        lease_expires_at timestamptz);
      CREATE TABLE writing_flow.scan_run (run_id int, status text,
        source_app_id text, source_table_id text);
      CREATE TABLE writing_flow.scan_item (run_id int, status text,
        next_send_at timestamptz, send_count int, last_sent_at timestamptz,
        receipt_plan jsonb);
      CREATE TABLE writing_flow.source_record (source_type text, dispatch_status text,
        next_dispatch_at timestamptz, last_dispatched_at timestamptz,
        source_app_id text, source_table_id text);
      INSERT INTO writing_flow.source_record VALUES
        ('manual','pending',now(),null,'a','b');`);
    let row = (await db.query(writingFlowWorkStatusSql)).rows[0];
    assert.equal(row.intake_due, true);
    assert.equal(row.source_due, false);
    await db.exec(`INSERT INTO writing_flow.scan_run VALUES (1,'open','a','b');
      INSERT INTO writing_flow.scan_item VALUES (1,'pending',now(),0,null,null);`);
    row = (await db.query(writingFlowWorkStatusSql)).rows[0];
    assert.equal(row.intake_due, false);
    assert.equal(row.source_due, true);
  } finally {
    await db.close();
  }
});
