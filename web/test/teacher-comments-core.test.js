import assert from "node:assert/strict";
import test from "node:test";
import { annotatedSegments, relocateThreadAnchor, threadsForField } from "../js/teacher-comments-core.js";

test("comment bám lại đúng đoạn sau khi học viên chèn chữ phía trước", () => {
  const anchor = relocateThreadAnchor("New: The figure rose sharply in 2009.", {
    start: 0,
    end: 23,
    quote: "The figure rose sharply",
    suffix: " in 2009."
  });
  assert.deepEqual(anchor, { start: 5, end: 28, quote: "The figure rose sharply", detached: false });
});

test("đoạn bị xóa làm comment detached nhưng thread và quote vẫn còn", () => {
  const threads = threadsForField([{ threadRef: "thread-1", fieldKey: "overview", anchor: { start: 0, end: 23, quote: "The figure rose sharply" } }], "overview", "A rewritten overview.");
  assert.equal(threads.length, 1);
  assert.equal(threads[0].anchor.detached, true);
  assert.equal(threads[0].anchor.quote, "The figure rose sharply");
});

test("hai comment giao nhau được highlight mà không làm mất chữ", () => {
  const text = "abcdefghij";
  const segments = annotatedSegments(text, [
    { threadRef: "a", anchor: { start: 1, end: 6, detached: false } },
    { threadRef: "b", anchor: { start: 4, end: 9, detached: false } },
  ]);
  assert.equal(segments.map(item => item.text).join(""), text);
  assert.deepEqual(segments.find(item => item.start === 4).threadRefs, ["a", "b"]);
});
