import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeWritingSearch, writingSearchPreview, writingSearchTokens } from '../src/writing-flow-search.js';

test('tìm nội dung bỏ dấu, viết hoa và dấu câu theo cùng một quy tắc', () => {
  assert.equal(normalizeWritingSearch('  Học viên viết: ĐỒ THỊ tăng!  '), 'hoc vien viet do thi tang');
});

test('chỉ mục HMAC ổn định, loại từ trùng và không chứa bản rõ', () => {
  const key = Buffer.alloc(32, 9);
  const first = writingSearchTokens('Boiler consumption boiler', key);
  const second = writingSearchTokens('boiler CONSUMPTION', key);
  assert.equal(first.length, 2);
  assert.deepEqual(first, second);
  assert.equal(first.every(token => token.length === 32), true);
  assert.equal(Buffer.concat(first).toString('utf8').includes('boiler'), false);
});

test('xem trước nội dung giữ xuống dòng và cắt có dấu báo', () => {
  assert.equal(writingSearchPreview('A   B\r\nC'), 'A B\nC');
  assert.equal(writingSearchPreview('abcdef', 4), 'abcd…');
});
