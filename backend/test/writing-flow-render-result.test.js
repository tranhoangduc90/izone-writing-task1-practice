// Nhận vào: biên nhận trang kết quả giả, không chứa bài học viên.
// Việc chính: chặn link sửa, mã trang khác, version khác hoặc chưa đọc lại.
// Trả ra: phép thử đạt; link sai không được chuyển sang bước ghi homework.
import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyWritingRenderResult, verifyWritingDeliveryResult,
  leaseSecondsForStage } from '../src/writing-flow-stage.js';
import { sha256 } from '../src/writing-flow-crypto.js';

const group = 'a'.repeat(48);
const result = { resultUrl: `https://ducizone.ddns.net/writing/shared/writing-essays/${group}/view?v=2`,
  writerGroupId: group, version: 2, correctionsCount: 2, readbackOk: true };

test('thời hạn chấm và ghi Test đủ biên; Homework giữ thời hạn hiện hành', () => {
  assert.equal(leaseSecondsForStage('main', 'term_test'), 1800);
  assert.equal(leaseSecondsForStage('main', 'google_classroom'), 600);
  assert.equal(leaseSecondsForStage('deliver', 'term_test'), 600);
  assert.equal(leaseSecondsForStage('deliver', 'google_classroom'), 180);
});

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

test('Test nhận bản nhận xét và điểm để ghi vào Docs, không tạo link LMS', () => {
  const reportMarkdown = '# Kết quả Writing Task 2\n\nĐiểm Task: **6.5**\n\n## Task Response: 6.5\n\nNhận xét đầy đủ.';
  const prepared = { reportMarkdown, taskScore: 6.5, readbackOk: true };
  assert.doesNotThrow(() => verifyWritingRenderResult(prepared, 'term_test'));
  assert.throws(() => verifyWritingRenderResult({ ...prepared, resultUrl: result.resultUrl }, 'term_test'));
  assert.throws(() => verifyWritingRenderResult({ ...prepared, reportMarkdown: '' }, 'term_test'));
  assert.throws(() => verifyWritingRenderResult({ ...prepared, taskScore: 7 }, 'term_test'));
  const delivered = { readbackOk: true, homeworkFileId: 'doc-1', essaySlot: 1,
    sourceLinkIndex: 1, writerPayloadHash: sha256(reportMarkdown) };
  const pair = { homework_file_id: 'doc-1', essay_slot: 1, source_link_index: 1 };
  assert.doesNotThrow(() => verifyWritingDeliveryResult(delivered, prepared, pair, 'term_test'));
  assert.throws(() => verifyWritingDeliveryResult({ ...delivered, writerPayloadHash: '0'.repeat(64) },
    prepared, pair, 'term_test'));
  assert.throws(() => verifyWritingDeliveryResult({ ...delivered, resultUrl: result.resultUrl },
    prepared, pair, 'term_test'));
});

test('Test nhận nguyên báo cáo HTML và Markdown của bộ chấm cũ', () => {
  const reportMarkdown = '<h1>Overall: <strong>6.5</strong></h1>\n'
    + '<div style="margin-left: 20px;"><h3>Task Response: 6.5</h3></div>\n'
    + '---\n# **Nhận xét từng tiêu chí:**\n## Task Response\n'
    + 'Bài có đủ nhận xét chi tiết cho từng tiêu chí và phần phát triển ý.';
  assert.doesNotThrow(() => verifyWritingRenderResult({ reportMarkdown,
    taskScore: 6.5, readbackOk: true }, 'term_test'));
  assert.throws(() => verifyWritingRenderResult({ reportMarkdown,
    taskScore: 7, readbackOk: true }, 'term_test'),
  error => error.code === 'RENDER_TEST_REPORT_INVALID');
});
