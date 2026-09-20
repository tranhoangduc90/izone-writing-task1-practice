import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

  const closeFinishedStage = queries.find(row =>
    row.sql.includes('FROM writing_flow.stage_result s'));
  assert.ok(closeFinishedStage, 'phải đóng bàn giao khi bước đích đã có kết quả cuối');
  assert.match(closeFinishedStage.sql, /h\.to_stage=s\.stage_key/u);
  assert.match(closeFinishedStage.sql, /'succeeded','skipped','needs_review'/u);
});

test('bàn giao được workflow gọi trực tiếp chỉ mở cứu hộ sau sáu giờ', () => {
  const intakeSource = fs.readFileSync(new URL('../src/writing-flow-intake.js', import.meta.url), 'utf8');
  const stageSource = fs.readFileSync(new URL('../src/writing-flow-stage.js', import.meta.url), 'utf8');
  const serviceSource = fs.readFileSync(new URL('../src/writing-flow-service.js', import.meta.url), 'utf8');

  assert.match(intakeSource,
    /VALUES \(\$1,'intake','precheck',\$2,now\(\)\+interval '6 hours'\)/u);
  assert.match(stageSource,
    /VALUES \(\$1,\$2,\$3,\$4,now\(\)\+interval '6 hours'\)/u);
  assert.match(stageSource,
    /VALUES \(\$1,'retry',\$2,\$3,now\(\)\+interval '6 hours'\)/u);
  assert.match(serviceSource,
    /VALUES \(\$1, 'review', \$2, \$3, 'pending', now\(\)\)/u);
});
