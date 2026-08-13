import test from "node:test";
import assert from "node:assert/strict";
import { hasMeaningfulText, normalizeProgress, pollingDelay, terminalResult, wordCount } from "../js/core.js";

test("normalizes public session data into two section states", () => {
  const result = normalizeProgress({ draftVersion: 4, draft: { overview: "A", body1: "B", body2: "C" }, sectionStates: { overview: { status: "passed" }, outline: { status: "revision", attemptsWithoutPass: 3 } } });
  assert.equal(result.revision, 4);
  assert.equal(result.texts.body2, "C");
  assert.equal(result.sections.overview.status, "passed");
  assert.equal(result.sections.outline.attemptsWithoutPass, 3);
});

test("polling backs off at the specified elapsed-time boundaries", () => {
  assert.equal(pollingDelay(0), 2000);
  assert.equal(pollingDelay(20000), 2000);
  assert.equal(pollingDelay(20001), 5000);
  assert.equal(pollingDelay(120000), 5000);
  assert.equal(pollingDelay(120001), 10000);
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
