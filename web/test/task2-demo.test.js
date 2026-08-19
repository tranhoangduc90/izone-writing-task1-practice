import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { task2DemoScenarios, task2DemoTask } from "../js/task2-demo-data.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifests", "writing-task2-practice-template.json"), "utf8"));

test("Task 2 demo dùng đúng đề crime prevention trong handout", () => {
  assert.equal(task2DemoTask.statement, "Some people think that the government should be responsible for crime prevention, while others believe that it is the responsibility of the individual to protect themselves. Discuss both views and give your opinion.");
  assert.doesNotMatch(JSON.stringify(task2DemoScenarios), /studentRef|credential|api.?key|Bearer |@/i);
});

test("Task 2 demo bao phủ chín tình huống thường gặp theo đúng thứ tự", () => {
  assert.deepEqual(task2DemoScenarios.map((scenario) => scenario.id), [
    "start",
    "topic-revision",
    "idea1-revision",
    "idea2-revision",
    "vocabulary-ready",
    "draft-writing",
    "draft-queued",
    "technical-error",
    "completed",
  ]);
  assert.ok(task2DemoScenarios.every((scenario) => manifest.sections.every((section) => scenario.sections[section.key])));
});

test("dữ liệu demo chỉ dùng các ô có trong manifest và mở từ vựng đúng lúc", () => {
  const allowed = new Set(manifest.sections.flatMap((section) => section.fields.map((field) => field.key)));
  assert.ok(task2DemoScenarios.every((scenario) => Object.keys(scenario.responses).every((key) => allowed.has(key))));
  const ready = task2DemoScenarios.find((scenario) => scenario.id === "vocabulary-ready");
  assert.ok(ready.vocabulary.length >= 6);
  assert.ok(["topic_sentence", "supporting_idea_1", "supporting_idea_2"].every((key) => ready.sections[key].status === "passed"));
  assert.ok(task2DemoScenarios.filter((scenario) => ["start", "topic-revision", "idea1-revision", "idea2-revision"].includes(scenario.id)).every((scenario) => scenario.vocabulary.length === 0));
});

test("tình huống hoàn tất có thẻ LMS còn lỗi kỹ thuật có thể thử lại", () => {
  const completed = task2DemoScenarios.find((scenario) => scenario.id === "completed");
  const failed = task2DemoScenarios.find((scenario) => scenario.id === "technical-error");
  assert.equal(completed.sections.draft.status, "passed");
  assert.ok(completed.lmsResponse.essays.length >= 2);
  assert.equal(failed.sections.draft.comments[0].status, "technical_error");
  assert.equal(failed.sections.draft.comments[0].canRetry, true);
});

test("trang demo là trang tĩnh và không kết nối dịch vụ production", () => {
  const html = fs.readFileSync(path.join(root, "task2-demo.html"), "utf8");
  const js = fs.readFileSync(path.join(root, "js", "task2-demo.js"), "utf8");
  assert.match(html, /connect-src 'self'/);
  assert.match(html, /Dữ liệu giả · không gọi AI/);
  assert.doesNotMatch(`${html}\n${js}`, /api\/v1|googleapis|n8n-webhook|studentRef/i);
});
