import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("dashboard giảng viên dùng cùng bộ thẻ LMS với giao diện học viên", async () => {
  const [teacher, api] = await Promise.all([
    readFile(new URL("../js/teacher-app.js", import.meta.url), "utf8"),
    readFile(new URL("../js/api.js", import.meta.url), "utf8"),
  ]);
  assert.match(teacher, /renderLmsDraftResult\(inline, result\.data/);
  assert.match(teacher, /state\.api\.draftResult\(student\.sessionRef\)/);
  assert.match(api, /sessions\/\$\{encodeURIComponent\(sessionRef\)\}\/draft-result/);
});

test("bảng từ vựng đứng ngay trước phần Draft ở cả hai giao diện", async () => {
  const [student, teacher] = await Promise.all([
    readFile(new URL("../js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../js/teacher-app.js", import.meta.url), "utf8"),
  ]);
  const studentDraft = student.slice(student.indexOf("function renderDraftFields"), student.indexOf("function renderSections"));
  assert.ok(studentDraft.indexOf("addDraftVocabulary(card)") < studentDraft.indexOf("addTextarea(card, \"draft\""));
  assert.match(teacher, /if \(sectionKey === "draft"\)[\s\S]*?bodySection\.append\(vocabulary\);[\s\S]*?const section = document\.createElement\("article"\)/);
});

test("pager giữ nguyên thẻ đang xem khi giao diện tự cập nhật", async () => {
  const [student, teacher, renderer] = await Promise.all([
    readFile(new URL("../js/app.js", import.meta.url), "utf8"),
    readFile(new URL("../js/teacher-app.js", import.meta.url), "utf8"),
    readFile(new URL("../js/lms-draft-result.js", import.meta.url), "utf8"),
  ]);
  assert.match(student, /initialIndex: app\.draftResult\.pageIndex/);
  assert.match(teacher, /initialIndex: result\.pageIndex/);
  assert.match(renderer, /showPage\(initialIndex\)/);
  assert.doesNotMatch(renderer, /scrollIntoView/);
});
