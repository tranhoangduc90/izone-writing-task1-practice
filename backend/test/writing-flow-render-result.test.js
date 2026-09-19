// Nhận vào: biên nhận trang kết quả giả, không chứa bài học viên.
// Việc chính: chặn link sửa, mã trang khác, version khác hoặc chưa đọc lại.
// Trả ra: phép thử đạt; link sai không được chuyển sang bước ghi homework.
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWritingRenderResult } from '../src/writing-flow-stage.js';

const group = 'a'.repeat(48);
const result = { resultUrl: `https://ducizone.ddns.net/writing/shared/writing-essays/${group}/view?v=2`,
  writerGroupId: group, version: 2, correctionsCount: 2, readbackOk: true };

test('chỉ link xem đã đọc lại của đúng trang và đúng version được nhận', () => {
  assert.doesNotThrow(() => verifyWritingRenderResult(result));
  for (const invalid of [
    { ...result, readbackOk: false },
    { ...result, resultUrl: result.resultUrl.replace('/view', '/edit') },
    { ...result, writerGroupId: 'b'.repeat(48) },
    { ...result, version: 3 },
    { ...result, correctionsCount: 0 },
  ]) {
    assert.throws(() => verifyWritingRenderResult(invalid),
      error => error.code === 'RENDER_READBACK_MISSING');
  }
});
