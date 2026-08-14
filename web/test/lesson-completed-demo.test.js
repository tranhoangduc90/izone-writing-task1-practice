import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { completedLessonDemo } from "../js/lesson-completed-demo-data.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifests", "writing-lesson13-young-leaders.json"), "utf8"));

test("completed Lesson 13 demo fills every field and shows revision history", () => {
  const fieldKeys = manifest.sections.flatMap((section) => section.fields.map((field) => field.key));
  assert.equal(fieldKeys.length, 18);
  assert.ok(fieldKeys.every((key) => completedLessonDemo.responses[key]?.trim()));
  assert.ok(manifest.sections.every((section) => completedLessonDemo.comments[section.key]?.length >= 2));
  assert.ok(manifest.sections.every((section) => completedLessonDemo.comments[section.key].at(-1).includes("👍")));
});

test("completed Lesson 13 demo has a safe two-column vocabulary table", () => {
  assert.ok(completedLessonDemo.vocabulary.length >= 8);
  assert.ok(completedLessonDemo.vocabulary.every((row) => row.length === 2 && row.every((cell) => cell.trim())));
  assert.doesNotMatch(JSON.stringify(completedLessonDemo), /Bearer |api.?key|credential|studentRef|@/i);
});

test("completed demo page is static and does not connect to the production API", () => {
  const html = fs.readFileSync(path.join(root, "lesson-completed-demo.html"), "utf8");
  assert.match(html, /connect-src 'self'/);
  assert.doesNotMatch(html, /ducizone|googleapis|studentRef|api\/v1/i);
});
