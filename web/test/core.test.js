import test from "node:test";
import assert from "node:assert/strict";
import { canUnlockDraft2, claimSectionSubmission, draftPrerequisitesPassed, hasMeaningfulText, isConflict, normalizeProgress, pollingDelay, rebaseLocalProgress, safeHttpUrl, safeLmsUrl, sectionSubmitLabel, terminalResult, wordCount } from "../js/core.js";

test("normalizes public session data into three section states", () => {
  const result = normalizeProgress({ draftVersion: 4, draft: { overview: "A", body1: "B", body2: "C", draft1: "D1", draft2: "D2", draft2Unlocked: true }, sectionStates: { overview: { status: "passed" }, outline: { status: "revision", attemptsWithoutPass: 3 } } });
  assert.equal(result.revision, 4);
  assert.equal(result.texts.body2, "C");
  assert.equal(result.texts.draft1, "D1");
  assert.equal(result.draft2Unlocked, true);
  assert.equal(result.sections.overview.status, "passed");
  assert.equal(result.sections.outline.attemptsWithoutPass, 3);
  assert.equal(result.sections.draft.status, "draft");
});

test("khôi phục bản IndexedDB giữ nguyên toàn bộ ô viết trong texts", () => {
  const restored = normalizeProgress({
    revision: 7,
    texts: { overview: "Overview cục bộ", body1: "Body 1 cục bộ", body2: "Body 2 cục bộ", draft1: "Draft 1 cục bộ", draft2: "Draft 2 cục bộ" },
    draft2Unlocked: true
  });
  assert.equal(restored.revision, 7);
  assert.deepEqual(restored.texts, {
    overview: "Overview cục bộ", body1: "Body 1 cục bộ", body2: "Body 2 cục bộ", draft1: "Draft 1 cục bộ", draft2: "Draft 2 cục bộ"
  });
  assert.equal(restored.draft2Unlocked, true);
});

test("polling backs off at the specified elapsed-time boundaries", () => {
  assert.equal(pollingDelay(0), 2000);
  assert.equal(pollingDelay(20000), 2000);
  assert.equal(pollingDelay(20001), 5000);
  assert.equal(pollingDelay(120000), 5000);
  assert.equal(pollingDelay(120001), 10000);
});

test("mỗi phần chỉ nhận một lượt gửi cho tới khi yêu cầu trước kết thúc", () => {
  const pendingSections = new Set();
  assert.equal(claimSectionSubmission(pendingSections, "overview"), true);
  assert.equal(claimSectionSubmission(pendingSections, "overview"), false);
  pendingSections.delete("overview");
  assert.equal(claimSectionSubmission(pendingSections, "overview"), true);
});

test("nút Check nói rõ trạng thái gửi và không yêu cầu học viên bấm lại", () => {
  assert.equal(sectionSubmitLabel("overview", "draft", true), "Đang gửi bài…");
  assert.equal(sectionSubmitLabel("overview", "queued"), "Đang chấm — không cần bấm lại");
  assert.equal(sectionSubmitLabel("draft", "queued"), "Đang tạo kết quả — không cần bấm lại");
});

test("word count ignores surrounding whitespace", () => {
  assert.equal(wordCount("  one\n two  three "), 3);
  assert.equal(wordCount(" "), 0);
});

test("meaningful blank removes whitespace and zero-width characters", () => {
  assert.equal(hasMeaningfulText(" \n\u200B\u200D\u2060\uFEFF "), false);
  assert.equal(hasMeaningfulText("\u200B Overview"), true);
});

test("outline accepts one completed body while a fully blank outline is blocked", () => {
  const canCheckOutline = (body1, body2) => [body1, body2].some(hasMeaningfulText);
  assert.equal(canCheckOutline("Body 1", ""), true);
  assert.equal(canCheckOutline("", "\u200B"), false);
});

test("Draft 2 only unlocks after meaningful Draft 1 and passed prerequisites", () => {
  assert.equal(canUnlockDraft2({ draft1: " \u200B " }), false);
  assert.equal(canUnlockDraft2({ draft1: "Overview and Body 1" }), true);
  assert.equal(draftPrerequisitesPassed({ overview: { status: "passed" }, outline: { status: "passed" } }), true);
  assert.equal(draftPrerequisitesPassed({ overview: { status: "passed" }, outline: { status: "revision" } }), false);
});

test("chỉ xung đột phiên bản lưu mới mở thẻ xung đột", () => {
  assert.equal(isConflict({ status: 409, data: { error: "DRAFT_VERSION_CONFLICT" } }), true);
  assert.equal(isConflict({ status: 409, data: { error: "DRAFT2_NOT_UNLOCKED" } }), false);
  assert.equal(isConflict({ status: 409, data: { error: "DRAFT_NOT_SAVED" } }), false);
});

test("dùng bản trên thiết bị giữ nguyên bài nhưng nhận phiên bản server mới", () => {
  const local = normalizeProgress({ draftVersion: 4, draft1: "Bài dài trên máy", draft2: "Bản sửa trên máy", draft2Unlocked: true });
  const rebased = rebaseLocalProgress(local, { draftVersion: 7, draft1: "Bản server", draft2: "", draft2Unlocked: false, updatedAt: "2026-08-16T04:10:00Z" });
  assert.equal(rebased.revision, 7);
  assert.equal(rebased.texts.draft1, "Bài dài trên máy");
  assert.equal(rebased.texts.draft2, "Bản sửa trên máy");
  assert.equal(rebased.draft2Unlocked, true);
});

test("public manifest URLs only allow HTTP and HTTPS", () => {
  assert.equal(safeHttpUrl("javascript:alert(1)"), null);
  assert.equal(safeHttpUrl("data:text/html,unsafe"), null);
  assert.equal(safeHttpUrl("assets/chart.png", "https://app.example/task/"), "https://app.example/task/assets/chart.png");
});

test("Draft result only accepts the official HTTPS LMS host", () => {
  assert.equal(safeLmsUrl("https://practice.izone.edu.vn/shared/writing-essays/example/edit?page=0"), "https://practice.izone.edu.vn/shared/writing-essays/example/edit?page=0");
  assert.equal(safeLmsUrl("http://practice.izone.edu.vn/shared/writing-essays/example/edit?page=0"), null);
  assert.equal(safeLmsUrl("https://practice.izone.edu.vn.evil.example/result"), null);
  assert.equal(safeLmsUrl("https://practice.izone.edu.vn/unrelated-page"), null);
  assert.equal(safeLmsUrl("javascript:alert(1)"), null);
});

test("completed attempt requires an explicit terminal resultStatus", () => {
  assert.equal(terminalResult({ status: "completed", resultStatus: "passed" }), true);
  assert.equal(terminalResult({ status: "completed", resultStatus: "needs_revision" }), true);
  assert.equal(terminalResult({ status: "completed" }), false);
  assert.equal(terminalResult({ status: "passed" }), true);
  assert.equal(terminalResult({ status: "failed" }), true);
});

test("normalizes section arrays returned by PostgreSQL API", () => {
  const result = normalizeProgress({ sections: [{ section: "overview", status: "passed", attemptsWithoutPass: 0 }, { section: "outline", status: "revision", attemptsWithoutPass: 6 }] });
  assert.equal(result.sections.overview.status, "passed");
  assert.equal(result.sections.outline.attemptsWithoutPass, 6);
});
