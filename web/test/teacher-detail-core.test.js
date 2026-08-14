import test from "node:test";
import assert from "node:assert/strict";
import { commentsForSection, isBackdropClick, latestVocabularyRows } from "../js/teacher-detail-core.js";

test("teacher detail shows newest comments for only the selected section", () => {
  const comments = [
    { section: "body1_topic", commentNumber: 1, feedback: "Cần sửa" },
    { section: "body1_support1", commentNumber: 1, feedback: "Phần khác" },
    { section: "body1_topic", commentNumber: 2, feedback: "Đã đạt" },
  ];
  assert.deepEqual(commentsForSection(comments, "body1_topic").map((item) => item.feedback), ["Đã đạt", "Cần sửa"]);
});

test("teacher detail uses the newest vocabulary artifact for each body", () => {
  const comments = [
    { createdAt: "2026-08-14T01:00:00Z", artifacts: { vocabulary: { body1: [{ idea: "cũ", terms: "old" }] } } },
    { createdAt: "2026-08-14T02:00:00Z", artifacts: { vocabulary: { body1: [{ idea: "mới", terms: "new" }] } } },
  ];
  assert.deepEqual(latestVocabularyRows(comments, "body1"), [{ idea: "mới", terms: "new" }]);
  assert.deepEqual(latestVocabularyRows(comments, "body2"), []);
});

test("only a click outside the dialog rectangle is treated as a backdrop click", () => {
  const rect = { left: 100, right: 900, top: 50, bottom: 700 };
  assert.equal(isBackdropClick({ clientX: 20, clientY: 200 }, rect), true);
  assert.equal(isBackdropClick({ clientX: 200, clientY: 200 }, rect), false);
});
