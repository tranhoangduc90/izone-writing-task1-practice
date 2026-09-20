import test from 'node:test';
import assert from 'node:assert/strict';
import { createWritingFlowHandoff } from '../src/writing-flow-handoff.js';

test('bàn giao đã được n8n nhận không bị phát lặp khi còn chờ suất chạy', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('RETURNING h.handoff_id')) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = {
    async connect() { return client; },
  };

  const result = await createWritingFlowHandoff({ pool }).due(720);
  assert.deepEqual(result, []);

  const claim = queries.find(row => row.sql.includes('WITH ready AS'));
  assert.ok(claim, 'phải có truy vấn cấp bàn giao');
  assert.deepEqual(claim.params, [720]);
  assert.match(claim.sql, /h\.status='pending'/u);
  assert.match(claim.sql, /h\.status='sent'/u);
  assert.match(claim.sql, /h\.last_sent_at<=now\(\)-interval '6 hours'/u);
  assert.match(claim.sql, /next_send_at=now\(\)\+interval '6 hours'/u);
  assert.doesNotMatch(claim.sql, /interval '30 seconds'/u);
});
