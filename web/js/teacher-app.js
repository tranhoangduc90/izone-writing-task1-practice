import { createTeacherApi } from "./api.js";
import { hasMeaningfulText } from "./core.js";
import { sectionDefinitions } from "./lesson-core.js";

const $ = (id) => document.getElementById(id);
const state = { token: "", api: null, manifest: null, activitySlug: "", students: [], pollTimer: null };

function showLoginError(value = "") { const node = $("teacher-login-error"); node.hidden = !value; node.textContent = value; }
function showDashboardError(value = "") { const node = $("teacher-error"); node.hidden = !value; node.textContent = value; }

function studentStatus(student) {
  const sections = Object.values(student.sections || {});
  if (sections.some((section) => section.status === "queued")) return "queued";
  if (sections.some((section) => section.status === "technical_error")) return "technical_error";
  if (sections.some((section) => section.status === "revision")) return "revision";
  if (sections.length && sections.every((section) => section.status === "passed")) return "passed";
  if (Object.values(student.responses || {}).some(hasMeaningfulText)) return "writing";
  return "not_started";
}

function statusLabel(status) {
  return ({ not_started: "Chưa làm", writing: "Đang viết", queued: "Đang chấm", technical_error: "Lỗi chấm", revision: "Cần sửa", passed: "Đã đạt" })[status] || "Chưa làm";
}

function formatTime(value) {
  return value ? new Date(value).toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Chưa có";
}

function populateClasses(students) {
  const select = $("teacher-class");
  const current = select.value;
  const existing = new Set([...select.options].map((option) => option.value));
  const classes = new Map(students.map((student) => [student.classRef, student.className]));
  for (const [classRef, className] of classes) {
    if (existing.has(classRef)) continue;
    const option = document.createElement("option"); option.value = classRef; option.textContent = className; select.append(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

function renderSummary(students) {
  const root = $("teacher-summary");
  root.replaceChildren();
  const statuses = ["not_started", "writing", "queued", "technical_error", "revision", "passed"];
  for (const status of statuses) {
    const card = document.createElement("article");
    card.className = "teacher-summary-card";
    card.dataset.state = status;
    const count = document.createElement("strong"); count.textContent = String(students.filter((student) => studentStatus(student) === status).length);
    const label = document.createElement("span"); label.textContent = statusLabel(status);
    card.append(count, label); root.append(card);
  }
}

function renderStudents(students) {
  const root = $("teacher-students");
  root.replaceChildren();
  if (!students.length) {
    const empty = document.createElement("p"); empty.className = "card muted"; empty.textContent = "Chưa có học viên trong phạm vi đã chọn."; root.append(empty); return;
  }
  for (const student of students) {
    const status = studentStatus(student);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "teacher-student-card";
    card.dataset.state = status;
    const header = document.createElement("span"); header.className = "teacher-student-header";
    const name = document.createElement("strong"); name.textContent = student.displayName;
    const badge = document.createElement("span"); badge.className = "section-status"; badge.dataset.state = status; badge.textContent = statusLabel(status);
    header.append(name, badge);
    const className = document.createElement("span"); className.className = "muted"; className.textContent = student.className;
    const meta = document.createElement("span"); meta.className = "teacher-student-meta";
    meta.textContent = `${student.online ? "Đang hoạt động" : "Không hoạt động"} · Lưu gần nhất: ${formatTime(student.savedAt)} · ${student.checkCount || 0} lần Check`;
    card.append(header, className, meta);
    if (student.supportWarning) {
      const warning = document.createElement("span"); warning.className = "teacher-support-warning"; warning.textContent = "Cần hỗ trợ"; card.append(warning);
    }
    card.addEventListener("click", () => showStudentDetail(student));
    root.append(card);
  }
}

function showStudentDetail(student) {
  const root = $("teacher-detail-content");
  root.replaceChildren();
  const heading = document.createElement("div"); heading.className = "teacher-detail-heading";
  const title = document.createElement("h2"); title.textContent = student.displayName;
  const meta = document.createElement("p"); meta.className = "muted"; meta.textContent = `${student.className} · ${statusLabel(studentStatus(student))} · Lưu gần nhất ${formatTime(student.savedAt)}`;
  heading.append(title, meta); root.append(heading);
  for (const body of state.manifest.bodies || []) {
    const bodySection = document.createElement("section"); bodySection.className = "teacher-detail-body";
    const bodyTitle = document.createElement("h3"); bodyTitle.textContent = body.title; bodySection.append(bodyTitle);
    for (const sectionKey of body.sectionKeys || []) {
      const definition = sectionDefinitions(state.manifest).find((item) => item.key === sectionKey);
      if (!definition) continue;
      const section = document.createElement("article"); section.className = "teacher-detail-section";
      const sectionTitle = document.createElement("h4");
      const sectionInfo = student.sections?.[sectionKey] || {};
      const sectionState = sectionInfo.status || "draft";
      sectionTitle.textContent = `${definition.title} · ${statusLabel(sectionState)}`;
      section.append(sectionTitle);
      if (sectionState === "technical_error" && sectionInfo.technicalAttemptRef) {
        const recovery = document.createElement("div");
        recovery.className = "teacher-ai-recovery";
        const message = document.createElement("p");
        message.textContent = "AI đã lỗi sau ba lần thử. Bài viết vẫn được lưu an toàn; bạn có thể xếp lại chính Comment này.";
        const retry = document.createElement("button");
        retry.type = "button";
        retry.className = "secondary";
        retry.textContent = "Xếp chấm lại";
        retry.addEventListener("click", async () => {
          retry.disabled = true;
          retry.textContent = "Đang xếp lại…";
          try {
            await state.api.retryFailedAttempt(sectionInfo.technicalAttemptRef);
            $("teacher-detail").close();
            await refresh();
          } catch (error) {
            retry.disabled = false;
            retry.textContent = "Xếp chấm lại";
            showDashboardError(error.message || "Chưa thể xếp chấm lại. Hệ thống sẽ giữ nguyên bài làm.");
          }
        });
        recovery.append(message, retry);
        section.append(recovery);
      }
      for (const field of definition.fields || []) {
        const fieldRoot = document.createElement("div"); fieldRoot.className = "teacher-response-field";
        if (student.activeField === field.key && student.online) fieldRoot.dataset.active = "true";
        const label = document.createElement("strong"); label.textContent = field.label;
        const value = document.createElement("p"); value.textContent = student.responses?.[field.key] || "Chưa viết";
        fieldRoot.append(label, value); section.append(fieldRoot);
      }
      bodySection.append(section);
    }
    root.append(bodySection);
  }
  $("teacher-detail").showModal();
}

async function refresh() {
  clearTimeout(state.pollTimer);
  if (!state.token) return;
  try {
    const result = await state.api.liveActivity(state.activitySlug, $("teacher-class").value);
    state.students = result.data.students || [];
    populateClasses(state.students);
    renderSummary(state.students);
    renderStudents(state.students);
    $("teacher-updated").textContent = `Cập nhật lúc ${formatTime(result.data.generatedAt)}`;
    showDashboardError();
  } catch (error) {
    if (error.status === 401) {
      state.token = "";
      $("teacher-dashboard").hidden = true;
      $("teacher-login").hidden = false;
      showLoginError("Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.");
      return;
    }
    showDashboardError("Chưa thể cập nhật dữ liệu lớp. Hệ thống sẽ tự thử lại.");
  }
  state.pollTimer = setTimeout(refresh, 5_000);
}

function handleCredential(response) {
  if (!response?.credential) return showLoginError("Không nhận được thông tin đăng nhập.");
  state.token = response.credential;
  $("teacher-login").hidden = true;
  $("teacher-dashboard").hidden = false;
  refresh();
}

async function waitForGoogle(clientId) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const accounts = globalThis.google?.accounts?.id;
    if (accounts) {
      accounts.initialize({ client_id: clientId, callback: handleCredential, auto_select: false });
      accounts.renderButton($("google-signin"), { theme: "outline", size: "large", text: "signin_with", locale: "vi" });
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Không tải được dịch vụ đăng nhập Google.");
}

async function init() {
  try {
    const slug = new URLSearchParams(location.search).get("task") || "writing-lesson13-young-leaders";
    const [manifestResponse, configResponse] = await Promise.all([
      fetch(`./manifests/${encodeURIComponent(slug)}.json`),
      fetch("./config.json", { cache: "no-store" }),
    ]);
    if (!manifestResponse.ok || !configResponse.ok) throw new Error("Thiếu cấu hình dashboard.");
    state.manifest = await manifestResponse.json();
    const config = await configResponse.json();
    if (!config.googleClientId) throw new Error("Dashboard chưa được cấu hình đăng nhập giảng viên.");
    state.activitySlug = state.manifest.activity?.slug || slug;
    state.api = createTeacherApi(config.apiBase || "", () => state.token);
    $("teacher-title").textContent = state.manifest.activity?.title || "Theo dõi bài làm";
    $("teacher-class").addEventListener("change", refresh);
    await waitForGoogle(config.googleClientId);
  } catch (error) {
    showLoginError(error.message);
  }
}

init();
