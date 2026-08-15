import test from 'node:test';
import assert from 'node:assert/strict';
import { createProvisionalStudentService, normalizeStudentName } from '../src/provisional-service.js';

test('chuẩn hóa tên loại ký tự vô hình/control và thu gọn khoảng trắng', () => {
  assert.equal(normalizeStudentName('  Nguyễn\u200b   Văn\u0007  An  '), 'Nguyễn Văn An');
});

test('API không khởi động chức năng mã tạm nếu pepper yếu', () => {
  assert.throws(() => createProvisionalStudentService({ pool: {}, pepper: 'ngắn' }), /32 ký tự/);
});
