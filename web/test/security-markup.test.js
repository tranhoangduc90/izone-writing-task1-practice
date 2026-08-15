import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('mọi ô mã 4 số đều che nội dung trên màn hình', async () => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  for (const id of ['access-code', 'provisional-pin', 'provisional-pin-confirm']) {
    assert.match(html, new RegExp(`<input[^>]*id="${id}"[^>]*type="password"`));
  }
});
