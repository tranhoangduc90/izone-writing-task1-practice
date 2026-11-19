import assert from 'node:assert/strict';
import test from 'node:test';
import { createK67LegacyCta } from '../src/reading-listening67/classroom-cta-legacy.js';

const documentId = 'fixture_document_123456789012345';
const old = 'NHẤN VÀO ĐÂY ĐỂ CHẤM BÀI NGAY';
const practice = 'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP READING';
const code = '67-practice-reading_c19_t4_p2_deep_sea_mining';
const event = { doc_id: documentId, class_name: 'IC2353' };
const context = { async assertOwnership() {} };

function makeDocument(rows) {
  let at = 1;
  const content = rows.map(text => {
    const value = text + '\n';
    const run = { startIndex: at, endIndex: at + value.length, textRun: { content: value, textStyle: { bold: true } } };
    at = run.endIndex;
    return { paragraph: { elements: [run] } };
  });
  return { documentId, revisionId: 'r1', tabs: [{ tabProperties: { tabId: 't.1' },
    documentTab: { body: { content } } }] };
}

function harness(rows, { changeOtherStyle = false, loseAck = false } = {}) {
  let current = makeDocument(rows);
  const writes = [];
  const units = new Set();
  const entryUrl = 'https://tranhoangduc90.github.io/izone-ai-team-pages/reading-practice/?' + new URLSearchParams({
    lesson: code, mode: 'student', class: event.class_name, documentId,
  });
  const docs = {
    async read(id) { assert.equal(id, documentId); return structuredClone(current); },
    async write(id, plan) {
      assert.equal(id, documentId);
      assert.equal(plan.revisionId, current.revisionId);
      writes.push(plan.requests.length);
      const content = current.tabs[0].documentTab.body.content;
      for (const request of plan.requests) {
        const { range, textStyle } = request.updateTextStyle;
        assert.equal(range.tabId, 't.1');
        const entry = content.find(row => row.paragraph.elements[0].startIndex === range.startIndex);
        const [run] = entry.paragraph.elements;
        const n = range.endIndex - range.startIndex;
        entry.paragraph.elements = [
          { startIndex: range.startIndex, endIndex: range.endIndex, textRun: {
            content: run.textRun.content.slice(0, n), textStyle: { ...run.textRun.textStyle, ...textStyle },
          } },
          { startIndex: range.endIndex, endIndex: run.endIndex, textRun: {
            content: run.textRun.content.slice(n), textStyle: run.textRun.textStyle,
          } },
        ];
      }
      if (changeOtherStyle) content.at(-1).paragraph.elements[0].textRun.textStyle.bold = false;
      current.revisionId = 'r' + (1 + writes.length);
      if (loseAck) throw Error('write committed before the response was lost');
    },
  };
  const register = async (received, destination) => {
    assert.equal(received, event);
    units.add(destination.assignmentCode);
    return { ...destination, ok: true, documentId, unitId: 'unit:' + destination.assignmentCode };
  };
  const adapter = createK67LegacyCta({
    docs, register,
    async practiceProof() { return { documentId, status: 'verified', code, entryUrl }; },
  });
  return { adapter, writes, units, current: () => current };
}

test('giữ ba vùng đúng lớp và đúng bài, kiểm readback khi mất ACK và ghi 0 khi replay', async () => {
  const h = harness([practice, code, old, '67-reading-01', old, '67-listening-02', 'Văn bản ngoài CTA'], { loseAck: true });
  assert.equal((await h.adapter(event, context)).status, 'verified');
  assert.deepEqual(h.writes, [3]);
  assert.deepEqual([...h.units], ['67-reading-01', '67-listening-02']);
  const revision = h.current().revisionId;
  assert.equal((await h.adapter(event, context)).status, 'verified');
  assert.deepEqual(h.writes, [3]);
  assert.equal(h.current().revisionId, revision);
});

test('bài mã sai vào cần rà, không đăng ký một phần và không chạm Docs', async () => {
  const h = harness([old, '67-reading-01', old, 'mã không hợp lệ']);
  assert.deepEqual(await h.adapter(event, context), {
    documentId, status: 'review', errorCode: 'CTA_2_ASSIGNMENT_CODE_INVALID',
  });
  assert.deepEqual(h.writes, []);
  assert.equal(h.units.size, 0);
});

test('đọc lại chặn cả thay đổi style ngoài CTA dù hyperlink hợp lệ', async () => {
  const h = harness([practice, code, 'Văn bản ngoài CTA'], { changeOtherStyle: true });
  await assert.rejects(h.adapter(event, context), { code: 'CTA_LEGACY_CONTENT_OR_STYLE_CHANGED' });
});
