import { createTeacherApi } from "./api.js";
import { hasMeaningfulText } from "./core.js";
import { sectionDefinitions } from "./lesson-core.js";
import { appendMarkdown } from "./markdown.js";
import { commentsForSection, isBackdropClick, latestVocabularyRows } from "./teacher-detail-core.js";

const $ = (id) => document.getElementById(id);
const state = { token: "", api: null, manifest: null, activitySlug: "", students: [], pollTimer: null,
  selectedStudent: null, detailRequestId: 0 };

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

function renderCommentTimeline(student, definition, loading) {
  const timeline = document.createElement("aside");
  timeline.className = "teacher-comment-timeline comments-panel";
  const heading = document.createElement("div");
  heading.className = "comments-heading";
  const headingText = document.createElement("div");
  const eyebrow = document.createElement("p"); eyebrow.className = "eyebrow"; eyebrow.textContent = "Nhận xét";
  const title = document.createElement("h4"); title.textContent = `Dòng thời gian · ${definition.title}`;
  headingText.append(eyebrow, title); heading.append(headingText); timeline.append(heading);
  const comments = commentsForSection(student.comments || [], definition.key);
  const list = document.createElement("ol"); list.className = "comment-list";
  for (const item of comments) {
    const entry = document.createElement("li"); entry.dataset.status = item.status || "completed";
    const meta = document.createElement("div"); meta.className = "comment-meta";
    meta.textContent = `Comment lần ${item.commentNumber || "?"}${item.status === "queued" ? " — Đang chấm" : ""} · ${item.createdAt ? new Date(item.createdAt).toLocaleString("vi-VN") : "Mới cập nhật"}`;
    const body = document.createElement("div"); body.className = "comment-body markdown-body";
    appendMarkdown(body, item.feedback || "Đã cập nhật trạng thái chấm.");
    entry.append(meta, body); list.append(entry);
  }
  timeline.append(list);
  if (!comments.length) {
    const empty = document.createElement("p"); empty.className = "muted empty-comments";
    empty.textContent = loading ? "Đang tải dòng thời gian nhận xét…" : "Chưa có nhận xét.";
    timeline.append(empty);
  }
  return timeline;
}

function renderVocabulary(bodySection, student, bodyKey, loading) {
  const vocabulary = document.createElement("section");
  vocabulary.className = "lesson-vocabulary teacher-detail-vocabulary";
  const title = document.createElement("h4");
  title.textContent = state.manifest.vocabulary?.title || "Từ vựng hỗ trợ";
  vocabulary.append(title);
  const rows = latestVocabularyRows(student.comments || [], bodyKey);
  if (!rows.length) {
    const empty = document.createElement("p"); empty.className = "muted";
    empty.textContent = loading ? "Đang tải bảng từ vựng…" : "Chưa có bảng từ vựng cho phần này.";
    vocabulary.append(empty); bodySection.append(vocabulary); return;
  }
  const tableRoot = document.createElement("div"); tableRoot.className = "table-scroll";
  const table = document.createElement("table");
  const head = document.createElement("thead"); const headRow = document.createElement("tr");
  for (const label of state.manifest.vocabulary?.columns || ["Ý cần diễn đạt", "Từ/cụm từ tiếng Anh"]) {
    const cell = document.createElement("th"); cell.textContent = label; headRow.append(cell);
  }
  head.append(headRow); table.append(head);
  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    const idea = document.createElement("td"); idea.textContent = row.idea;
    const terms = document.createElement("td"); terms.textContent = Array.isArray(row.terms) ? row.terms.join(", ") : row.terms;
    tr.append(idea, terms); tbody.append(tr);
  }
  table.append(tbody); tableRoot.append(table); vocabulary.append(tableRoot); bodySection.append(vocabulary);
}

function renderStudentDetail(student, { loading = false, error = "" } = {}) {
  const dialog = $("teacher-detail");
  const previousScroll = dialog.scrollTop;
  const root = $("teacher-detail-content");
  root.replaceChildren();
  const heading = document.createElement("div"); heading.className = "teacher-detail-heading";
  const title = document.createElement("h2"); title.textContent = student.displayName;
  const meta = document.createElement("p"); meta.className = "muted"; meta.textContent = `${student.className} · ${statusLabel(studentStatus(student))} · Lưu gần nhất ${formatTime(student.savedAt)}`;
  heading.append(title, meta); root.append(heading);
  const prompt = document.createElement("article"); prompt.className = "teacher-detail-prompt";
  const promptLabel = document.createElement("p"); promptLabel.className = "eyebrow"; promptLabel.textContent = "Đề bài";
  const promptTitle = document.createElement("h3"); promptTitle.textContent = state.manifest.task?.title || "Essay question";
  const promptText = document.createElement("div"); promptText.className = "markdown-body";
  appendMarkdown(promptText, state.manifest.task?.statement || "");
  prompt.append(promptLabel, promptTitle, promptText); root.append(prompt);
  for (const body of state.manifest.bodies || []) {
    const bodySection = document.createElement("section"); bodySection.className = "teacher-detail-body";
    const bodyTitle = document.createElement("h3"); bodyTitle.textContent = body.title;
    const bodyDescription = document.createElement("p"); bodyDescription.className = "muted"; bodyDescription.textContent = body.description || "";
    bodySection.append(bodyTitle, bodyDescription);
    for (const sectionKey of body.sectionKeys || []) {
      const definition = sectionDefinitions(state.manifest).find((item) => item.key === sectionKey);
      if (!definition) continue;
      const section = document.createElement("article"); section.className = "teacher-detail-section";
      const sectionKicker = document.createElement("p"); sectionKicker.className = "section-kicker"; sectionKicker.textContent = definition.kicker || "";
      const sectionTitle = document.createElement("h4");
      const sectionInfo = student.sections?.[sectionKey] || {};
      const sectionState = sectionInfo.status || "draft";
      section.dataset.state = sectionState;
      sectionTitle.textContent = `${definition.title} · ${statusLabel(sectionState)}`;
      const sectionInstruction = document.createElement("p"); sectionInstruction.className = "muted teacher-detail-instruction"; sectionInstruction.textContent = definition.instruction || "";
      section.append(sectionKicker, sectionTitle, sectionInstruction);
      const sectionLayout = document.createElement("div"); sectionLayout.className = "teacher-detail-section-layout";
      const responseColumn = document.createElement("div"); responseColumn.className = "teacher-detail-responses";
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
            await refresh();
          } catch (error) {
            retry.disabled = false;
            retry.textContent = "Xếp chấm lại";
            showDashboardError(error.message || "Chưa thể xếp chấm lại. Hệ thống sẽ giữ nguyên bài làm.");
          }
        });
        recovery.append(message, retry);
        responseColumn.append(recovery);
      }
      for (const field of definition.fields || []) {
        const fieldRoot = document.createElement("div"); fieldRoot.className = "teacher-response-field";
        if (student.activeField === field.key && student.online) fieldRoot.dataset.active = "true";
        const label = document.createElement("strong"); label.textContent = field.label;
        const value = document.createElement("p"); value.textContent = student.responses?.[field.key] || "Chưa viết";
        fieldRoot.append(label, value); responseColumn.append(fieldRoot);
      }
      sectionLayout.append(responseColumn, renderCommentTimeline(student, definition, loading));
      section.append(sectionLayout);
      bodySection.append(section);
    }
    renderVocabulary(bodySection, student, body.key, loading);
    root.append(bodySection);
  }
  if (error) {
    const message = document.createElement("p"); message.className = "notice"; message.textContent = error; root.prepend(message);
  }
  if (dialog.open) requestAnimationFrame(() => { dialog.scrollTop = previousScroll; });
}

async function loadStudentDetail(student) {
  if (!student?.sessionRef) {
    state.selectedStudent = student;
    renderStudentDetail(student);
    return;
  }
  const requestId = ++state.detailRequestId;
  try {
    const result = await state.api.liveSession(student.sessionRef);
    if (requestId !== state.detailRequestId || !$("teacher-detail").open) return;
    const session = result.data.session || result.data;
    const sections = { ...(session.sections || {}), ...(student.sections || {}) };
    state.selectedStudent = { ...student, ...session, sections };
    renderStudentDetail(state.selectedStudent);
  } catch (error) {
    if (requestId !== state.detailRequestId || !$("teacher-detail").open) return;
    renderStudentDetail(student, { error: error.message || "Chưa thể tải dòng thời gian nhận xét." });
  }
}

function showStudentDetail(student) {
  state.selectedStudent = student;
  renderStudentDetail(student, { loading: Boolean(student.sessionRef) });
  const dialog = $("teacher-detail");
  if (!dialog.open) dialog.showModal();
  void loadStudentDetail(student);
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
    if ($("teacher-detail").open && state.selectedStudent) {
      const updated = state.students.find((student) => student.studentRef === state.selectedStudent.studentRef);
      if (updated) await loadStudentDetail({ ...state.selectedStudent, ...updated });
    }
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
    const detail = $("teacher-detail");
    detail.addEventListener("click", (event) => {
      if (event.target === detail && isBackdropClick(event, detail.getBoundingClientRect())) detail.close();
    });
    detail.addEventListener("close", () => {
      state.detailRequestId += 1;
      state.selectedStudent = null;
    });
    await waitForGoogle(config.googleClientId);
  } catch (error) {
    showLoginError(error.message);
  }
}

init();
