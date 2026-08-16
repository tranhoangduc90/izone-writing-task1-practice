import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("comment giảng viên không thay thế hoặc can thiệp luồng Check AI hiện tại", async () => {
  const [task1, lesson, api, commentUi] = await Promise.all([
    readFile(new URL("../js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../js/lesson-app.js", import.meta.url), "utf8"),
    readFile(new URL("../js/api.js", import.meta.url), "utf8"),
    readFile(new URL("../js/teacher-comments-ui.js", import.meta.url), "utf8"),
  ]);
  assert.match(task1, /saveRemote\("check"\)/);
  assert.match(task1, /api\.checkSection/);
  assert.match(lesson, /saveRemote\("check"\)/);
  assert.match(lesson, /api\.checkSection/);
  assert.doesNotMatch(commentUi, /checkSection|attemptsWithoutPass|supportWarning|Gemini|n8n/);
  assert.doesNotMatch(api, /teacher-comments[^\n]+DELETE/i);
});

test("giao diện học viên không có nút xóa, chấp thuận hoặc ẩn comment", async () => {
  const source = await readFile(new URL("../js/teacher-comments-ui.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, />\s*(Xóa|Chấp thuận|Ẩn comment)\s*</i);
  assert.match(source, /Đã xử lý · vẫn lưu trong lịch sử/);
});
