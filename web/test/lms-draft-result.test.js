import test from "node:test";
import assert from "node:assert/strict";
import { draftPagerState, normalizeLmsDraftPayload, proseMirrorBlocks } from "../js/lms-draft-result.js";

const paragraph = (text, highlighted = false) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text, ...(highlighted ? { marks: [{ type: "highlight" }] } : {}) }] }],
});

test("chỉ lấy từng thẻ essay và bỏ hoàn toàn màn TR/CC", () => {
  const result = normalizeLmsDraftPayload({
    content: "KHÔNG ĐƯỢC HIỂN THỊ",
    feedback: "KHÔNG ĐƯỢC HIỂN THỊ",
    essays: [{ id: "card-1", index: 0, content: paragraph("Gốc"), suggestedContent: paragraph("Sửa"), comments: ["<p>Nhận xét câu</p>"] }],
  });
  assert.equal(result.essays.length, 1);
  assert.equal(result.essays[0].comments[0], "<p>Nhận xét câu</p>");
  assert.equal(JSON.stringify(result).includes("KHÔNG ĐƯỢC HIỂN THỊ"), false);
});

test("giữ đúng highlight của bản gốc và bản gợi ý", () => {
  const blocks = proseMirrorBlocks(paragraph("more balanced", true));
  assert.deepEqual(blocks, [{ type: "paragraph", runs: [{ text: "more balanced", highlighted: true }] }]);
});

test("xếp thẻ theo index của LMS và giới hạn dữ liệu đầu vào", () => {
  const result = normalizeLmsDraftPayload({ essays: [
    { id: "later", index: 4, content: paragraph("B"), suggestedContent: paragraph("B2"), comments: [] },
    { id: "first", index: 1, content: paragraph("A"), suggestedContent: paragraph("A2"), comments: ["x".repeat(25_000)] },
  ] });
  assert.deepEqual(result.essays.map((item) => item.id), ["first", "later"]);
  assert.equal(result.essays[0].comments[0].length, 20_000);
});

test("pager chặn ở thẻ đầu và cuối", () => {
  assert.deepEqual(draftPagerState(-2, 4), { index: 0, position: 1, total: 4, atStart: true, atEnd: false });
  assert.deepEqual(draftPagerState(2, 4), { index: 2, position: 3, total: 4, atStart: false, atEnd: false });
  assert.deepEqual(draftPagerState(20, 4), { index: 3, position: 4, total: 4, atStart: false, atEnd: true });
});
