import test from "node:test";
import assert from "node:assert/strict";
import { advanceLiveDemo, createLiveDemoState, demoMetrics, forceNextAiFailures } from "../js/teacher-demo-core.js";

test("live demo starts every queued AI job without a fixed four-job cap", () => {
  const state = createLiveDemoState();
  assert.equal(state.students.length, 40);
  const queuedBefore = demoMetrics(state).waiting;
  assert.ok(queuedBefore > 4);
  advanceLiveDemo(state);
  assert.equal(demoMetrics(state).running, queuedBefore);
});

test("a transient AI failure retries the same Comment while database saves continue", () => {
  const state = createLiveDemoState();
  const attemptRef = forceNextAiFailures(state, 1);
  const original = state.jobs.find((job) => job.attemptRef === attemptRef);
  const commentNumber = original.commentNumber;
  const savesBefore = state.totalDatabaseSaves;
  for (let index = 0; index < 8; index += 1) advanceLiveDemo(state);
  const retried = state.jobs.find((job) => job.attemptRef === attemptRef);
  assert.equal(retried.commentNumber, commentNumber);
  assert.equal(state.jobs.filter((job) => job.attemptRef === attemptRef).length, 1);
  assert.ok(retried.retryCount >= 1);
  assert.notEqual(retried.status, "failed");
  assert.ok(state.totalDatabaseSaves > savesBefore);
});

test("three AI failures create a teacher-recoverable technical error without a revision streak", () => {
  const state = createLiveDemoState();
  const attemptRef = forceNextAiFailures(state, 3);
  const job = state.jobs.find((item) => item.attemptRef === attemptRef);
  const student = state.students[job.studentIndex];
  const streakBefore = student.failStreak;
  for (let index = 0; index < 15 && job.status !== "failed"; index += 1) advanceLiveDemo(state);
  assert.equal(job.status, "failed");
  assert.equal(student.status, "technical_error");
  assert.equal(student.failStreak, streakBefore);
});
