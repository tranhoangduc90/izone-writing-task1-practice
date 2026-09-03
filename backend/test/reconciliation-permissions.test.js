// Nhận migration quyền ghép hồ sơ; kiểm đúng cột và không mở quyền xóa/đọc mapping.
// Khi thiếu hoặc thừa quyền, test thất bại trước khi phát hành; kiểm PostgreSQL thật chạy riêng ở staging.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const sql = readFileSync(new URL('../../docs/migrations/2026-09-03-reconciliation-override-permissions.sql', import.meta.url), 'utf8')
  .replace(/--[^\n]*/g, '').trim();

test('reconciliation grants only the columns needed by the API UPSERT', () => {
  const grants = Object.fromEntries([...sql.matchAll(/(SELECT|INSERT|UPDATE)\s*\(([^)]+)\)/g)]
    .map(([, verb, columns]) => [verb, columns.split(',').map(column => column.trim()).sort()]));
  const common = ['student_public_id', 'display_name', 'active', 'approved_by', 'reason'];
  assert.deepEqual(grants, {
    SELECT: [...common, 'activity_class_id', 'erp_student_contact_id', 'updated_at'].sort(),
    INSERT: [...common, 'activity_class_id', 'erp_student_contact_id'].sort(),
    UPDATE: [...common, 'updated_at'].sort()
  });
  assert.match(sql, /^BEGIN;/);
  assert.match(sql, /ON writing_practice\.activity_roster_override TO writing_practice_api;/);
  assert.match(sql, /COMMIT;$/);
  assert.doesNotMatch(sql, /\b(?:DELETE|TRUNCATE|ALL|PUBLIC)\b|\bmapping\./i);
  assert.equal((sql.match(/\bGRANT\b/g) || []).length, 1);
});
