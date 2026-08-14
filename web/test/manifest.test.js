import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("sample manifest follows the public v1 shape and contains no sensitive fields", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifests", "sample-task.json"), "utf8"));
  assert.equal(manifest.schema_version, "task1-web-manifest-v1");
  assert.match(manifest.activity.id, /^[0-9a-f-]{36}$/i);
  assert.equal(manifest.activity.slug, "sample-task");
  assert.ok(manifest.task.statement);
  assert.ok(manifest.analysis.bullets.length);
  assert.equal(manifest.routes.filter((route) => route.recommended).length, 1);
  assert.doesNotMatch(JSON.stringify(manifest), /grader.?prompt|credential|api.?key|student.?data|Bearer /i);
});

test("pilot manifest contains the released chart and six approved routes", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifests", "pie-app-users-by-age.json"), "utf8"));
  assert.equal(manifest.schema_version, "task1-web-manifest-v1");
  assert.equal(manifest.activity.slug, "pie-app-users-by-age");
  assert.equal(manifest.task.chart_image.url, "assets/task1-pie-app-age-groups.png");
  assert.equal(manifest.routes.length, 6);
  assert.equal(manifest.routes.filter((route) => route.recommended).length, 1);
  assert.equal(manifest.vocabulary.routes.length, manifest.routes.length);
  assert.doesNotMatch(JSON.stringify(manifest), /grader.?prompt|credential|api.?key|student.?data|Bearer /i);
});

test("public config only contains non-secret browser configuration", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  assert.deepEqual(Object.keys(config), ["apiBase", "googleClientId"]);
  assert.doesNotMatch(JSON.stringify(config), /token|secret|credential|authorization/i);
});

test("Lesson 13 manifest merges Body 1 and Body 2 without private grading prompts", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifests", "writing-lesson13-young-leaders.json"), "utf8"));
  assert.equal(manifest.schemaVersion, "lesson-handout.v1");
  assert.equal(manifest.bodies.length, 2);
  assert.equal(manifest.sections.length, 6);
  assert.equal(new Set(manifest.sections.flatMap((section) => section.fields.map((field) => field.key))).size, 18);
  assert.ok(manifest.sections.every((section) => section.requiredFields.length === 3));
  const middleFields = manifest.sections.flatMap((section) => section.fields).filter((field) => field.key.endsWith("_x"));
  const finalFields = manifest.sections.flatMap((section) => section.fields).filter((field) => field.key.endsWith("_b"));
  assert.ok(middleFields.every((field) => field.placeholder === "Giải thích cơ chế dẫn đến điểm cuối / Làm rõ cho điểm đầu…"));
  assert.ok(finalFields.every((field) => field.placeholder === "Điều muốn chứng minh - Hệ quả cuối cùng…"));
  assert.doesNotMatch(JSON.stringify(manifest), /grader.?prompt|credential|api.?key|student.?data|Bearer /i);
});

test("student identity uses native selects for both class and name on mobile", () => {
  for (const filename of ["index.html", "lesson.html"]) {
    const html = fs.readFileSync(path.join(root, filename), "utf8");
    assert.doesNotMatch(html, /<datalist/i);
    assert.match(html, /<select[^>]+(?:student-name|lesson-student)/i);
    assert.match(html, /Chọn họ và tên của bạn/);
  }
});
