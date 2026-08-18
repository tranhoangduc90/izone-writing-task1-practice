import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseMarkdownBlocks } from "../js/markdown.js";

const VERSION = "20260818-numbering-v2";

test("comment đánh số trong dữ liệu LMS thật được render thành một danh sách liên tục", async () => {
  const fixture = JSON.parse(await readFile(new URL("../demo-lms-draft-result.json", import.meta.url), "utf8"));
  const comment = fixture.lmsResponse.essays.flatMap((essay) => essay.comments || [])
    .find((value) => /^1\./u.test(value));
  const blocks = parseMarkdownBlocks(comment);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, "list");
  assert.equal(blocks[0].ordered, true);
  assert.deepEqual(blocks[0].items.map((item) => item.text.split(":", 1)[0]), ["Chẩn đoán", "Cách sửa", "Ghi nhớ"]);
});

test("bản học viên và giảng viên cùng tải bộ Markdown đã sửa, không dùng cache cũ", async () => {
  const sources = await Promise.all([
    "../js/app.js",
    "../js/lesson-app.js",
    "../js/teacher-app.js",
    "../js/lms-draft-result.js",
    "../index.html",
    "../lesson.html",
    "../teacher.html",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of sources) assert.match(source, new RegExp(VERSION));
  assert.match(sources[0], new RegExp(`markdown\\.js\\?v=${VERSION}`));
  assert.match(sources[1], new RegExp(`markdown\\.js\\?v=${VERSION}`));
  assert.match(sources[2], new RegExp(`markdown\\.js\\?v=${VERSION}`));
  assert.match(sources[3], new RegExp(`markdown\\.js\\?v=${VERSION}`));
});
