import { advanceLiveDemo, createLiveDemoState, demoMetrics, demoStatusLabel, forceNextAiFailures } from "./teacher-demo-core.js";

const $ = (id) => document.getElementById(id);
let state = createLiveDemoState();
let timer = null;

function relativeSave(student) {
  if (student.savedAtTick === null) return "Chưa lưu";
  const seconds = Math.max(0, (state.tick - student.savedAtTick) * 5);
  return seconds === 0 ? "Vừa lưu" : `${seconds} giây trước`;
}

function renderMetrics() {
  const metrics = demoMetrics(state);
  const values = [
    ["Đang hoạt động", metrics.online, "writing"],
    ["Đã có bản lưu", metrics.saved, "passed"],
    ["AI đang chấm", String(metrics.running), "queued"],
    ["Đang chờ", metrics.waiting, "queued"],
    ["Lỗi chấm", metrics.counts.technical_error, "technical_error"],
    ["Tổng lượt lưu", metrics.totalDatabaseSaves, "not_started"],
  ];
  const root = $("live-demo-summary");
  root.replaceChildren();
  for (const [labelText, value, status] of values) {
    const card = document.createElement("article");
    card.className = "teacher-summary-card";
    card.dataset.state = status;
    const strong = document.createElement("strong"); strong.textContent = String(value);
    const label = document.createElement("span"); label.textContent = labelText;
    card.append(strong, label); root.append(card);
  }
}

function renderStudents() {
  const activeJobs = new Map(state.jobs.filter((job) => ["queued", "running", "waiting_retry", "failed"].includes(job.status)).map((job) => [job.studentIndex, job]));
  const root = $("live-demo-students");
  root.replaceChildren();
  state.students.forEach((student, index) => {
    const job = activeJobs.get(index);
    const article = document.createElement("article");
    article.className = "teacher-student-card live-demo-student-card";
    article.dataset.state = student.status;
    const header = document.createElement("span"); header.className = "teacher-student-header";
    const name = document.createElement("strong"); name.textContent = student.displayName;
    const badge = document.createElement("span"); badge.className = "section-status"; badge.dataset.state = student.status; badge.textContent = demoStatusLabel(student.status);
    header.append(name, badge);
    const meta = document.createElement("span"); meta.className = "teacher-student-meta";
    meta.textContent = `${student.online ? "Đang hoạt động" : "Chưa vào"} · ${relativeSave(student)} · ${student.checkCount} lần Check`;
    article.append(header, meta);
    if (job) {
      const detail = document.createElement("span"); detail.className = "live-demo-job";
      detail.textContent = job.status === "failed"
        ? `Comment lần ${job.commentNumber} · cần giảng viên xếp lại`
        : `Comment lần ${job.commentNumber} · thử ${job.retryCount + 1}/3`;
      article.append(detail);
    }
    root.append(article);
  });
}

function renderEvents() {
  const root = $("live-demo-events");
  root.replaceChildren();
  for (const event of state.events) {
    const item = document.createElement("li"); item.dataset.kind = event.kind;
    const time = document.createElement("strong"); time.textContent = `+${event.tick * 5} giây`;
    const message = document.createElement("span"); message.textContent = event.text;
    item.append(time, message); root.append(item);
  }
}

function render() {
  renderMetrics();
  renderStudents();
  renderEvents();
  $("live-demo-updated").textContent = state.paused ? "Đang tạm dừng" : `Đã cập nhật · +${state.tick * 5} giây`;
  $("live-demo-pause").textContent = state.paused ? "Tiếp tục" : "Tạm dừng";
}

function schedule() {
  clearInterval(timer);
  timer = setInterval(() => {
    advanceLiveDemo(state);
    render();
  }, 1_000);
}

$("live-demo-reset").addEventListener("click", () => { state = createLiveDemoState(); render(); });
$("live-demo-pause").addEventListener("click", () => { state.paused = !state.paused; render(); });
$("live-demo-fail-once").addEventListener("click", () => { forceNextAiFailures(state, 1); render(); });
$("live-demo-fail-three").addEventListener("click", () => { forceNextAiFailures(state, 3); render(); });

render();
schedule();
