import assert from 'node:assert/strict';
import test from 'node:test';
import { sha256 } from '../src/writing-flow-crypto.js';
import { WEB_SUBSTITUTE_PROFILES } from '../src/writing-flow-web-identity.js';
import { getPinnedWebPrompt, WEB_SUBSTITUTE_REGISTRY } from '../src/writing-flow-web-registry.js';

// Dữ liệu vào: bốn prompt và phiên bản từ bộ chấm cũ đã đối chiếu với Pages.
// Việc chính: phát hiện đổi chữ/Task/ảnh hoặc truy vấn rubric khác bản đã duyệt.
// Kết quả: chỉ đúng bốn tổ hợp được mở; không dùng nhầm ảnh K67 cho pizza K56.
// Khi lỗi: backend chặn mở lượt trước khi nhận bài.
test('bốn đề Substitute ghim đúng Task, prompt và ảnh', () => {
  assert.deepEqual(Object.keys(WEB_SUBSTITUTE_REGISTRY).sort(),
    Object.keys(WEB_SUBSTITUTE_PROFILES).sort());
  for (const [testSlug, pinned] of Object.entries(WEB_SUBSTITUTE_REGISTRY)) {
    const normalized = pinned.topic.normalize('NFC').replace(/\s+/gu, ' ').trim();
    assert.equal(sha256(normalized), pinned.promptSha256, testSlug);
    assert.deepEqual(WEB_SUBSTITUTE_PROFILES[testSlug].tasks, [pinned.taskNumber]);
    assert.equal(getPinnedWebPrompt({ testSlug, taskNumber: pinned.taskNumber,
      rubricVersion: pinned.rubricVersion }), pinned);
    assert.equal(getPinnedWebPrompt({ testSlug, taskNumber: 3 - pinned.taskNumber,
      rubricVersion: pinned.rubricVersion }), null);
    assert.equal(getPinnedWebPrompt({ testSlug, taskNumber: pinned.taskNumber,
      rubricVersion: 'old-or-wrong-version' }), null);
  }
  const pizza = WEB_SUBSTITUTE_REGISTRY['substitute-test-2-k56'];
  assert.equal(pizza.imageSha256,
    '1296e1095e8517d17208e7edb31a907c251d93ba21476d15b07629fea07fb612');
  assert.equal(pizza.imageUrl.endsWith(`/${pizza.imageSha256}.png`), true);
  for (const [slug, pinned] of Object.entries(WEB_SUBSTITUTE_REGISTRY)) {
    if (slug !== 'substitute-test-2-k56') {
      assert.equal(pinned.imageUrl, null);
      assert.equal(pinned.imageSha256, null);
    }
  }
});
