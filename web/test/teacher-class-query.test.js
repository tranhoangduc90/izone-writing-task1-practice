import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("teacher dashboard áp dụng class query trước khi hiển thị danh sách học viên", async () => {
  const source = await readFile(new URL("../js/teacher-app.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../teacher.html", import.meta.url), "utf8");
  assert.match(source, /import \{ classQuery, resolveClassRef \}/u);
  assert.match(source, /state\.requestedClass = classQuery\(location\.search\)/u);
  assert.match(source, /return refresh\(\)/u);
  assert.match(html, /20260822-class-query-v1/u);
});
