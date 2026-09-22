import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(new URL(
  '../../docs/migrations/2026-09-22-writing-flow-nonwriting-source-filter-v9.sql', import.meta.url),
'utf8');

test('dọn lỗi nguồn giữ dữ liệu gốc, chặn nguồn đã có bài và không dùng DELETE', () => {
  assert.doesNotMatch(sql, /\bDELETE\b/iu);
  assert.match(sql, /source\.source_type='google_classroom'/u);
  assert.match(sql, /NOT EXISTS \(SELECT 1 FROM writing_flow\.pair/u);
  assert.match(sql, /dispatch_status='excluded'/u);
  assert.match(sql, /writing-source-title-v1/u);
  assert.match(sql, /issue\.status='open'/u);
  assert.match(sql, /registry\.class_status IS DISTINCT FROM 'completed'/u);
});
