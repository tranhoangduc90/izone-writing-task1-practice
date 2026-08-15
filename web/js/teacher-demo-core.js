const STATUS_LABELS = {
  not_started: "Chưa làm",
  writing: "Đang viết",
  queued: "Đang chờ chấm",
  running: "AI đang chấm",
  technical_error: "Lỗi chấm",
  revision: "Cần sửa",
  passed: "Đã đạt",
};

export function demoStatusLabel(status) {
  return STATUS_LABELS[status] || STATUS_LABELS.not_started;
}

function addEvent(state, kind, text) {
  state.events.unshift({ tick: state.tick, kind, text });
  state.events = state.events.slice(0, 14);
}

function enqueue(state, studentIndex) {
  const student = state.students[studentIndex];
  if (!student || ["queued", "running"].includes(student.status)) return null;
  student.status = "queued";
  student.checkCount += 1;
  const job = {
    attemptRef: `demo-attempt-${String(state.nextAttempt).padStart(3, "0")}`,
    studentIndex,
    commentNumber: student.checkCount,
    status: "queued",
    retryCount: 0,
    retryAtTick: null,
    startedTick: null,
    failuresRemaining: 0,
  };
  state.nextAttempt += 1;
  state.jobs.push(job);
  return job;
}

function runningJobFor(state, studentIndex) {
  return state.jobs.find((job) => job.studentIndex === studentIndex && ["queued", "running", "waiting_retry"].includes(job.status));
}

export function createLiveDemoState(studentCount = 40) {
  const state = {
    tick: 0,
    nextAttempt: 1,
    totalDatabaseSaves: 0,
    automaticFailurePending: true,
    students: [],
    jobs: [],
    events: [],
    paused: false,
  };
  for (let index = 0; index < studentCount; index += 1) {
    const status = index < 8 ? "not_started" : index < 26 ? "writing" : index < 34 ? "queued" : index < 37 ? "revision" : "passed";
    state.students.push({
      displayName: `Học viên demo ${String(index + 1).padStart(2, "0")}`,
      status,
      online: index >= 4,
      savedAtTick: index >= 8 ? 0 : null,
      checkCount: status === "revision" || status === "passed" ? 1 : 0,
      failStreak: status === "revision" ? 1 : 0,
      activeField: status === "writing" ? "Supporting Idea" : "",
    });
  }
  for (let index = 26; index < Math.min(34, studentCount); index += 1) {
    state.students[index].status = "writing";
    enqueue(state, index);
  }
  addEvent(state, "info", `Đã tải một bản tổng hợp gồm ${studentCount} học viên giả.`);
  return state;
}

export function forceNextAiFailures(state, failureCount = 1) {
  let job = state.jobs.find((item) => ["running", "queued", "waiting_retry"].includes(item.status));
  if (!job) {
    const studentIndex = state.students.findIndex((student) => student.status === "writing");
    job = enqueue(state, studentIndex);
  }
  if (!job) return null;
  job.failuresRemaining = Math.max(job.failuresRemaining, Math.max(1, Math.min(3, failureCount)));
  addEvent(state, "warning", failureCount >= 3 ? "Đã lên lịch mô phỏng AI lỗi liên tiếp ba lần." : "Đã lên lịch mô phỏng AI lỗi một lần.");
  return job.attemptRef;
}

function saveIndependentDrafts(state) {
  const candidates = state.students.filter((student) => student.online && student.status !== "not_started");
  const savesThisTick = Math.min(4, candidates.length);
  for (let offset = 0; offset < savesThisTick; offset += 1) {
    const student = candidates[(state.tick * 3 + offset) % candidates.length];
    student.savedAtTick = state.tick;
  }
  state.totalDatabaseSaves += savesThisTick;
}

function wakeRetries(state) {
  for (const job of state.jobs) {
    if (job.status === "waiting_retry" && job.retryAtTick <= state.tick) {
      job.status = "queued";
      job.retryAtTick = null;
      addEvent(state, "info", `${state.students[job.studentIndex].displayName}: tự xếp lại Comment lần ${job.commentNumber}.`);
    }
  }
}

function finishRunningJobs(state) {
  const ready = state.jobs.filter((job) => job.status === "running" && job.startedTick < state.tick);
  for (const job of ready) {
    const student = state.students[job.studentIndex];
    const shouldAutoFail = state.automaticFailurePending && state.tick >= 2;
    const shouldFail = job.failuresRemaining > 0 || shouldAutoFail;
    if (shouldFail) {
      if (job.failuresRemaining > 0) job.failuresRemaining -= 1;
      if (shouldAutoFail) state.automaticFailurePending = false;
      job.retryCount += 1;
      if (job.retryCount < 3) {
        job.status = "waiting_retry";
        job.retryAtTick = state.tick + 2;
        student.status = "queued";
        addEvent(state, "warning", `${student.displayName}: AI lỗi, giữ nguyên Comment lần ${job.commentNumber} và tự thử lại (${job.retryCount}/3).`);
      } else {
        job.status = "failed";
        student.status = "technical_error";
        addEvent(state, "danger", `${student.displayName}: AI lỗi ba lần; bài vẫn an toàn và giảng viên có thể xếp lại cùng Comment.`);
      }
      continue;
    }
    const passed = (job.studentIndex + state.tick + job.retryCount) % 3 === 0;
    job.status = "completed";
    student.status = passed ? "passed" : "revision";
    student.failStreak = passed ? 0 : student.failStreak + 1;
    addEvent(state, passed ? "success" : "info", `${student.displayName}: Comment lần ${job.commentNumber} đã có kết quả ${passed ? "Đã đạt" : "Cần sửa"}.`);
  }
}

function startQueuedJobs(state) {
  for (const job of state.jobs) {
    if (job.status !== "queued") continue;
    job.status = "running";
    job.startedTick = state.tick;
    state.students[job.studentIndex].status = "running";
  }
}

function addClassActivity(state) {
  if (state.tick % 2 === 0) {
    const notStarted = state.students.find((student) => student.status === "not_started");
    if (notStarted) {
      notStarted.status = "writing";
      notStarted.online = true;
      notStarted.savedAtTick = state.tick;
      notStarted.activeField = "Topic Sentence";
    }
  }
  if (state.tick % 3 === 0) {
    const index = state.students.findIndex((student) => student.status === "writing" && !runningJobFor(state, state.students.indexOf(student)));
    if (index >= 0) enqueue(state, index);
  }
}

export function advanceLiveDemo(state) {
  if (state.paused) return state;
  state.tick += 1;
  saveIndependentDrafts(state);
  wakeRetries(state);
  finishRunningJobs(state);
  addClassActivity(state);
  startQueuedJobs(state);
  return state;
}

export function demoMetrics(state) {
  const counts = Object.fromEntries(Object.keys(STATUS_LABELS).map((status) => [status, 0]));
  for (const student of state.students) counts[student.status] = (counts[student.status] || 0) + 1;
  return {
    counts,
    online: state.students.filter((student) => student.online).length,
    saved: state.students.filter((student) => student.savedAtTick !== null).length,
    totalDatabaseSaves: state.totalDatabaseSaves,
    running: state.jobs.filter((job) => job.status === "running").length,
    waiting: state.jobs.filter((job) => ["queued", "waiting_retry"].includes(job.status)).length,
  };
}
