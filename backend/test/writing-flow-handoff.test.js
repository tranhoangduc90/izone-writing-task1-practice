import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createWritingFlowHandoff } from '../src/writing-flow-handoff.js';

// Hồi quy cho lỗi production 42601: SQL động có thể thừa dấu ngoặc dù test mock
// vẫn chạy. Bộ đếm bỏ qua chuỗi SQL và yêu cầu mọi ngoặc đóng đúng thứ tự.
function assertSqlParenthesesBalanced(sql) {
  let depth = 0;
  let inString = false;
  for (let index = 0; index < sql.length; index += 1) {
    const char = sql[index];
    if (char === "'") {
      if (inString && sql[index + 1] === "'") index += 1;
      else inString = !inString;
    } else if (!inString && char === '(') depth += 1;
    else if (!inString && char === ')') {
      depth -= 1;
      assert.ok(depth >= 0, 'SQL không được có ngoặc đóng thừa');
    }
  }
  assert.equal(inString, false, 'SQL phải đóng chuỗi ký tự');
  assert.equal(depth, 0, 'SQL phải cân bằng dấu ngoặc');
}

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

  const claims = queries.filter(row => row.sql.includes('WITH ready AS'));
  assert.equal(claims.length, 2, 'phải tách lượt ghi Google khỏi các bước còn lại');
  assert.deepEqual(claims.map(row => row.params), [[20], [720]]);
  for (const claim of claims) {
    assert.match(claim.sql, /h\.status='pending'/u);
    assert.match(claim.sql, /h\.status='sent'/u);
    assert.match(claim.sql, /h\.last_sent_at<=now\(\)-interval '6 hours'/u);
    assert.match(claim.sql, /next_send_at=now\(\)\+interval '6 hours'/u);
    assert.doesNotMatch(claim.sql, /interval '30 seconds'/u);
  }

  const closeFinishedStage = queries.find(row =>
    row.sql.includes('FROM writing_flow.stage_result s'));
  assert.ok(closeFinishedStage, 'phải đóng bàn giao khi bước đích đã có kết quả cuối');
  assert.match(closeFinishedStage.sql, /h\.to_stage=s\.stage_key/u);
  assert.match(closeFinishedStage.sql, /s\.status IN \('succeeded','skipped'\)/u);
  assert.match(closeFinishedStage.sql,
    /s\.status='needs_review' AND h\.from_stage<>'review'/u);
  assert.doesNotMatch(closeFinishedStage.sql,
    /s\.status IN \('succeeded','skipped','needs_review'\)/u);
});

test('bàn giao retry từ danh sách cần kiểm tra không bị đóng trước khi workflow nhận', async () => {
  const queries = [];
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('RETURNING h.handoff_id')) {
        return { rowCount: 1, rows: [{
          handoff_id: 'handoff-review', pair_id: 'pair-review',
          to_stage: 'precheck', send_count: 1, submission_revision: 'a'.repeat(64),
        }] };
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };

  const [result] = await createWritingFlowHandoff({ pool }).due(1);
  assert.equal(result.handoffId, 'handoff-review');
  assert.equal(result.stageKey, 'precheck');
  const closeFinishedStage = queries.find(row =>
    row.sql.includes('FROM writing_flow.stage_result s'));
  assert.match(closeFinishedStage.sql,
    /s\.status='needs_review' AND h\.from_stage<>'review'/u);
});

test('mỗi lượt dành tối đa hai mươi chỗ cho bước ghi Google và giữ phần còn lại cho các bước AI', async () => {
  const queries = [];
  let claimNo = 0;
  const client = {
    async query(sql, params = []) {
      queries.push({ sql, params });
      if (sql.includes('RETURNING h.handoff_id')) {
        claimNo += 1;
        if (claimNo === 1) {
          return { rows: Array.from({ length: 20 }, (_, index) => ({
            handoff_id: `handoff-deliver-${index}`,
            pair_id: `pair-deliver-${index}`,
            to_stage: 'deliver',
            send_count: 1,
            submission_revision: 'a'.repeat(64),
          })), rowCount: 20 };
        }
      }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  const pool = { async connect() { return client; } };

  await createWritingFlowHandoff({ pool }).due(100);
  const claims = queries.filter(row => row.sql.includes('RETURNING h.handoff_id'));
  assert.equal(claims.length, 2);
  assert.deepEqual(claims.map(row => row.params), [[20], [80]]);
  assert.match(claims[0].sql, /h\.to_stage='deliver'/u);
  assert.match(claims[0].sql, /sibling_pair\.homework_file_id=p\.homework_file_id/u);
  assert.match(claims[0].sql, /sibling\.last_sent_at>now\(\)-interval '15 minutes'/u);
  assert.match(claims[0].sql,
    /sibling\.next_send_at,sibling\.created_at,sibling\.handoff_id/u);
  assertSqlParenthesesBalanced(claims[0].sql);
  assertSqlParenthesesBalanced(claims[1].sql);
  assert.match(claims[1].sql, /h\.to_stage<>'deliver'/u);
  assert.doesNotMatch(claims[1].sql, /sibling_pair\.homework_file_id/u);
});

test('bàn giao trực tiếp giữ cứu hộ sáu giờ, retry quota dùng mốc do chính sách cấp', () => {
  const intakeSource = fs.readFileSync(new URL('../src/writing-flow-intake.js', import.meta.url), 'utf8');
  const stageSource = fs.readFileSync(new URL('../src/writing-flow-stage.js', import.meta.url), 'utf8');
  const serviceSource = fs.readFileSync(new URL('../src/writing-flow-service.js', import.meta.url), 'utf8');

  assert.match(intakeSource,
    /VALUES \(\$1,'intake','precheck',\$2,now\(\)\+interval '6 hours'\)/u);
  assert.match(stageSource,
    /VALUES \(\$1,\$2,\$3,\$4,now\(\)\+interval '6 hours'\)/u);
  assert.match(stageSource,
    /VALUES \(\$1,'retry',\$2,\$3,now\(\)\+\(\$4::text\|\|' seconds'\)::interval\)/u);
  assert.match(serviceSource,
    /VALUES \(\$1, 'review', \$2, \$3, 'pending', now\(\)\)/u);
});
