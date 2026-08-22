import { createTeacherApi } from "./api.js?v=20260818-teacher-lms-vocab";
import { classQuery, resolveClassRef } from "./class-selection.js";
import { createRequestId, hasMeaningfulText, safeLmsUrl } from "./core.js";
import { sectionDefinitions } from "./lesson-core.js";
import { appendMarkdown } from "./markdown.js?v=20260818-numbering-v3";
import { commentsForSection, isBackdropClick, latestVocabularyRows } from "./teacher-detail-core.js";
import { groupStudents } from "./teacher-progress.js";
import { teacherAuthFailure } from "./teacher-auth-ui.js";
import { selectionOffsets, threadsForField } from "./teacher-comments-core.js";
import { createTeacherCommentThreadCard, renderAnnotatedText } from "./teacher-comments-ui.js";
import { renderLmsDraftResult } from "./lms-draft-result.js?v=20260818-numbering-v3";
import { createVocabularySection, manifestVocabularyRows } from "./vocabulary-ui.js?v=20260818-vocabulary-scroll";

const $ = (id) => document.getElementById(id);
const state = { token: "", api: null, manifest: null, activitySlug: "", students: [], pollTimer: null,
  selectedStudent: null, detailRequestId: 0, focusSection: "", pending: [], canManage: false, draftResults: new Map(),
  requestedClass: "", classQueryResolved: false, classQueryError: "" };

function teacherDefinitions() {
  const dynamic = sectionDefinitions(state.manifest);
  if (dynamic.length) return dynamic;
  return [
    { key: "overview", title: "Overview", kicker: "Task 1", instruction: "Tổng quan nổi bật", fields: [{ key: "overview", label: "Overview" }] },
    { key: "outline", title: "Body Outline", kicker: "Task 1", instruction: "Dàn ý hai thân bài", fields: [{ key: "body1", label: "Body 1" }, { key: "body2", label: "Body 2" }] },
    { key: "draft", title: "Draft", kicker: "Task 1", instruction: "Draft 1 và Draft 2", fields: [{ key: "draft1", label: "Draft 1" }, { key: "draft2", label: "Draft 2" }] }
  ];
}

function teacherBodies() {
  return state.manifest.bodies?.length ? state.manifest.bodies : [{ key: "task1", title: "Bài làm Task 1", description: "", sectionKeys: teacherDefinitions().map(item => item.key) }];
}

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
  return [...classes].map(([classRef, className]) => ({ classRef, className }));
}

function renderSummary(students) {
  const root = $("teacher-summary");
  root.replaceChildren();
  const support = document.createElement("button"); support.type = "button"; support.className = "teacher-summary-card"; support.dataset.state = "support";
  const supportCount = document.createElement("strong"); supportCount.textContent = String(students.filter(item => item.supportRequired).length);
  const supportLabel = document.createElement("span"); supportLabel.textContent = "Cần hỗ trợ"; support.append(supportCount, supportLabel);
  support.addEventListener("click", () => document.querySelector('[data-group="support"]')?.scrollIntoView({ behavior: "smooth", block: "start" })); root.append(support);
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
  for (const group of groupStudents(students)) {
    if (!group.students.length) continue;
    const section = document.createElement("section"); section.className = "teacher-group"; section.dataset.group = group.key;
    const groupTitle = document.createElement("h2"); groupTitle.className = "teacher-group-title"; groupTitle.textContent = `${group.title} · ${group.students.length}`; section.append(groupTitle);
    for (const student of group.students) {
    const status = studentStatus(student);
    const card = document.createElement("button");
    card.type = "button";
    card.className = "teacher-student-card";
    card.dataset.state = status;
    card.dataset.priority = student.supportRequired ? "support" : "normal";
    card.dataset.started = String(Boolean(student.hasStarted));
    const header = document.createElement("span"); header.className = "teacher-student-header";
    const name = document.createElement("strong"); name.textContent = student.displayName;
    const badge = document.createElement("span"); badge.className = "section-status"; badge.dataset.state = status; badge.textContent = statusLabel(status);
    header.append(name, badge);
    const className = document.createElement("span"); className.className = "muted"; className.textContent = student.className;
    const meta = document.createElement("span"); meta.className = "teacher-student-meta";
    meta.textContent = `${student.online ? "Đang hoạt động" : "Không hoạt động"} · Lưu gần nhất: ${formatTime(student.savedAt)} · ${student.checkCount || 0} lần Check`;
    const progress = document.createElement("span"); progress.className = "teacher-progress";
    const track = document.createElement("span"); track.className = "teacher-progress-track"; const fill = document.createElement("span"); fill.className = "teacher-progress-fill"; fill.style.width = `${student.progressPercent || 0}%`; track.append(fill);
    const progressText = document.createElement("span"); progressText.textContent = `${student.progressPercent || 0}%`; progress.append(track, progressText);
    const metrics = document.createElement("span"); metrics.className = "muted"; metrics.textContent = `${student.filledFields || 0}/${student.totalFields || 0} ô · ${student.passedSectionCount || 0} phần đạt · ${student.checkCount || 0} lần Check`;
    const badges = document.createElement("span"); badges.className = "teacher-badges";
    if (student.supportRequired) {
      for (const item of student.supportSections || []) { const warning = document.createElement("span"); warning.className = "teacher-support-warning"; warning.textContent = `⚠ Cần liên hệ giảng viên · ${item.section} · Comment lần ${item.commentNumber}`; badges.append(warning); }
    }
    if (student.provisional) { const provisional = document.createElement("span"); provisional.className = "teacher-provisional-badge"; provisional.textContent = "Học viên tạm · Cần đối soát"; badges.append(provisional); }
    if (!student.hasStarted) { const blank = document.createElement("span"); blank.className = "teacher-not-started-badge"; blank.textContent = "Chưa làm"; badges.append(blank); }
    card.append(header, className, progress, metrics, meta, badges);
    card.addEventListener("click", () => showStudentDetail(student, student.supportSections?.[0]?.section || ""));
    section.append(card);
    }
    root.append(section);
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
  const latest = comments[0];
  const lmsUrl = definition.key === "draft" ? safeLmsUrl(latest?.artifacts?.lmsUrl || latest?.feedback) : null;
  if (lmsUrl) {
    timeline.classList.add("draft-result-panel"); list.classList.add("draft-result-list");
    const item = document.createElement("li"); item.className = "draft-result-box"; item.dataset.status = latest.status || "completed";
    const meta = document.createElement("div"); meta.className = "comment-meta";
    meta.textContent = latest.createdAt ? `Cập nhật ${new Date(latest.createdAt).toLocaleString("vi-VN")}` : "Kết quả Draft 2";
    const inline = document.createElement("div"); inline.className = "lms-inline-result"; item.append(meta, inline);
    const key = `${student.sessionRef}:${lmsUrl}`;
    const cached = state.draftResults.get(key);
    if (!cached) {
      state.draftResults.set(key, { status: "loading", data: null, pageIndex: 0 });
      void state.api.draftResult(student.sessionRef).then(({ data }) => {
        state.draftResults.set(key, { status: "loaded", data: data.result, pageIndex: 0 });
        if (state.selectedStudent?.sessionRef === student.sessionRef && $("teacher-detail").open) renderStudentDetail(state.selectedStudent);
      }).catch(() => {
        state.draftResults.set(key, { status: "error", data: null, pageIndex: 0 });
        if (state.selectedStudent?.sessionRef === student.sessionRef && $("teacher-detail").open) renderStudentDetail(state.selectedStudent);
      });
    }
    const result = state.draftResults.get(key);
    if (result?.status === "loaded") renderLmsDraftResult(inline, result.data, {
      updatedAt: result.data?.updatedAt || latest.createdAt,
      initialIndex: result.pageIndex,
      onPageChange: (pageIndex) => { result.pageIndex = pageIndex; },
    });
    else {
      const message = document.createElement("p"); message.className = "draft-result-message";
      message.textContent = result?.status === "error" ? "Chưa tải được các thẻ nhận xét từ LMS." : "Đang tải các thẻ nhận xét…";
      inline.append(message);
    }
    const link = document.createElement("a"); link.className = "lms-result-link lms-result-fallback"; link.href = lmsUrl; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.textContent = result?.status === "error" ? "Mở kết quả trên LMS" : "Mở bản gốc trên LMS";
    item.append(link); list.append(item); timeline.append(list);
    return timeline;
  }
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

async function reloadSelectedStudent() {
  if (state.selectedStudent?.sessionRef) await loadStudentDetail(state.selectedStudent);
}

function renderTeacherResponseField(responseColumn, student, definition, field) {
  const fieldRoot = document.createElement("div"); fieldRoot.className = "teacher-response-field";
  if (student.activeField === field.key && student.online) fieldRoot.dataset.active = "true";
  const label = document.createElement("strong"); label.textContent = field.label;
  const value = document.createElement("div"); value.className = "teacher-annotatable-text"; value.tabIndex = 0;
  value.setAttribute("aria-label", `${field.label}. Bôi đen một đoạn để thêm comment.`);
  const responseText = student.responses?.[field.key] || "";
  const fieldThreads = threadsForField(student.teacherComments || [], field.key, responseText);
  const threads = document.createElement("div"); threads.className = "teacher-comment-thread-list teacher-comment-thread-list-dashboard";
  const focusThread = (threadRef) => threads.querySelector(`[data-thread-ref="${CSS.escape(threadRef)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (responseText) renderAnnotatedText(value, responseText, fieldThreads, focusThread);
  else { value.textContent = "Chưa viết"; value.classList.add("muted"); }

  const composer = document.createElement("form"); composer.className = "teacher-comment-composer"; composer.hidden = true;
  const selectedQuote = document.createElement("blockquote");
  const input = document.createElement("textarea"); input.rows = 3; input.maxLength = 5000; input.placeholder = "Viết comment cho đoạn đã chọn…"; input.setAttribute("aria-label", "Nội dung comment mới");
  const actions = document.createElement("div"); actions.className = "actions";
  const cancel = document.createElement("button"); cancel.type = "button"; cancel.className = "secondary compact"; cancel.textContent = "Hủy";
  const submit = document.createElement("button"); submit.type = "submit"; submit.className = "primary compact"; submit.textContent = "Comment";
  actions.append(cancel, submit); composer.append(selectedQuote, input, actions);
  let selected = null;
  const captureSelection = () => {
    if (!responseText) return;
    const next = selectionOffsets(value);
    if (!next || next.end - next.start > 2000) return;
    selected = next; selectedQuote.textContent = next.quote; composer.hidden = false; input.focus();
  };
  value.addEventListener("mouseup", captureSelection);
  value.addEventListener("keyup", (event) => { if (event.key === "Shift" || event.key.startsWith("Arrow")) captureSelection(); });
  cancel.addEventListener("click", () => { selected = null; input.value = ""; composer.hidden = true; });
  composer.addEventListener("submit", async (event) => {
    event.preventDefault(); const body = input.value.trim(); if (!selected || !body) return;
    submit.disabled = true; submit.textContent = "Đang lưu…";
    try {
      await state.api.createTeacherComment(student.sessionRef, {
        sectionKey: definition.key,
        fieldKey: field.key,
        start: selected.start,
        end: selected.end,
        baseVersion: student.draftVersion,
        body,
        requestId: createRequestId(),
      });
      await reloadSelectedStudent();
    } catch (error) {
      submit.disabled = false; submit.textContent = "Comment";
      showDashboardError(error.message || "Chưa lưu được comment. Bài có thể vừa thay đổi; hãy bôi lại đoạn chữ.");
    }
  });

  for (const thread of fieldThreads) {
    threads.append(createTeacherCommentThreadCard(thread, {
      allowStatus: true,
      onReply: async (item, body) => { await state.api.replyTeacherComment(item.threadRef, body); await reloadSelectedStudent(); },
      onStatus: async (item, status) => { await state.api.setTeacherCommentStatus(item.threadRef, status); await reloadSelectedStudent(); },
    }));
  }
  const empty = document.createElement("p"); empty.className = "muted teacher-comment-empty"; empty.textContent = responseText ? "Bôi đen một đoạn trong bài để thêm comment." : "Học viên chưa viết ô này.";
  empty.hidden = fieldThreads.length > 0;
  const layout = document.createElement("div"); layout.className = "teacher-response-comment-layout";
  const response = document.createElement("div"); response.className = "teacher-response-comment-source"; response.append(value, composer, empty);
  layout.append(response, threads); fieldRoot.append(label, layout); responseColumn.append(fieldRoot);
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
  for (const body of teacherBodies()) {
    const bodySection = document.createElement("section"); bodySection.className = "teacher-detail-body";
    const bodyTitle = document.createElement("h3"); bodyTitle.textContent = body.title;
    const bodyDescription = document.createElement("p"); bodyDescription.className = "muted"; bodyDescription.textContent = body.description || "";
    bodySection.append(bodyTitle, bodyDescription);
    for (const sectionKey of body.sectionKeys || []) {
      const definition = teacherDefinitions().find((item) => item.key === sectionKey);
      if (!definition) continue;
      if (sectionKey === "draft") {
        const vocabulary = createVocabularySection(document, manifestVocabularyRows(state.manifest?.vocabulary), {
          className: "teacher-detail-vocabulary teacher-draft-vocabulary",
          headingTag: "h4",
          scrollHint: "Cuộn trong bảng để xem thêm. Phần Draft ở ngay bên dưới ↓",
        });
        if (vocabulary) bodySection.append(vocabulary);
      }
      const section = document.createElement("article"); section.className = "teacher-detail-section";
      section.dataset.sectionKey = sectionKey;
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
        message.textContent = state.canManage
          ? "AI đã lỗi sau ba lần thử. Bài viết vẫn được lưu an toàn; bạn có thể xếp lại chính Comment này."
          : "AI đã lỗi sau ba lần thử. Bài viết vẫn được lưu an toàn; hãy báo tài khoản quản trị để xếp chấm lại.";
        recovery.append(message);
        if (state.canManage) {
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
        recovery.append(retry);
        }
        responseColumn.append(recovery);
      }
      for (const field of definition.fields || []) {
        renderTeacherResponseField(responseColumn, student, definition, field);
      }
      sectionLayout.append(responseColumn, renderCommentTimeline(student, definition, loading));
      section.append(sectionLayout);
      bodySection.append(section);
    }
    if (!(body.sectionKeys || []).includes("draft")) renderVocabulary(bodySection, student, body.key, loading);
    root.append(bodySection);
  }
  if (error) {
    const message = document.createElement("p"); message.className = "notice"; message.textContent = error; root.prepend(message);
  }
  if (dialog.open) requestAnimationFrame(() => { dialog.scrollTop = previousScroll; });
  if (state.focusSection) requestAnimationFrame(() => root.querySelector(`[data-section-key="${CSS.escape(state.focusSection)}"]`)?.scrollIntoView({ block: "center" }));
}

async function loadStudentDetail(student) {
  if (!student?.sessionRef) {
    state.selectedStudent = student;
    renderStudentDetail(student);
    return;
  }
  const requestId = ++state.detailRequestId;
  try {
    const [result, commentResult] = await Promise.all([state.api.liveSession(student.sessionRef), state.api.teacherComments(student.sessionRef)]);
    if (requestId !== state.detailRequestId || !$("teacher-detail").open) return;
    const session = result.data.session || result.data;
    const sections = { ...(session.sections || {}), ...(student.sections || {}) };
    state.selectedStudent = { ...student, ...session, sections, teacherComments: commentResult.data.threads || [] };
    renderStudentDetail(state.selectedStudent);
  } catch (error) {
    if (requestId !== state.detailRequestId || !$("teacher-detail").open) return;
    renderStudentDetail(student, { error: error.message || "Chưa thể tải dòng thời gian nhận xét." });
  }
}

function showStudentDetail(student, focusSection = "") {
  state.selectedStudent = student;
  state.focusSection = focusSection;
  renderStudentDetail(student, { loading: Boolean(student.sessionRef) });
  const dialog = $("teacher-detail");
  if (!dialog.open) dialog.showModal();
  void loadStudentDetail(student);
}

function renderReconciliation() {
  const panel = $("teacher-reconciliation"); const root = $("teacher-reconciliation-list"); root.replaceChildren();
  panel.hidden = !state.pending.length;
  for (const item of state.pending) {
    const row = document.createElement("article"); row.className = "teacher-student-card";
    const title = document.createElement("strong"); title.textContent = `${item.displayName} · ${item.className}`;
    if (!state.canManage) {
      const note = document.createElement("span"); note.className = "muted"; note.textContent = "Chỉ xem · Tài khoản quản trị sẽ đối soát hồ sơ này.";
      row.append(title, note); root.append(row); continue;
    }
    const candidates = state.students.filter(student => student.classRef === item.classRef && !student.provisional);
    const select = document.createElement("select"); const placeholder = document.createElement("option"); placeholder.value = ""; placeholder.textContent = "Chọn hồ sơ chính thức"; select.append(placeholder);
    for (const candidate of candidates) { const option = document.createElement("option"); option.value = candidate.studentRef; option.textContent = candidate.displayName; select.append(option); }
    const actions = document.createElement("span"); actions.className = "actions";
    const reset = document.createElement("button"); reset.type = "button"; reset.className = "secondary"; reset.textContent = "Đặt lại mã";
    reset.addEventListener("click", async () => { const result = await state.api.resetProvisionalCode(item.studentRef); alert(`Mã mới của ${item.displayName}: ${result.data.accessCode}\nMã chỉ hiển thị lần này.`); });
    const match = document.createElement("button"); match.type = "button"; match.className = "primary"; match.textContent = "Ghép hồ sơ";
    match.addEventListener("click", async () => { if (!select.value) return; try { await state.api.reconcileProvisional(item.studentRef, select.value); await refresh(); } catch (error) { showDashboardError(error.message); } });
    actions.append(reset, match); row.append(title, select, actions); root.append(row);
  }
}

async function refresh() {
  clearTimeout(state.pollTimer);
  if (!state.token) return;
  try {
    const selectedClassRef = $("teacher-class").value;
    const result = await state.api.liveActivity(state.activitySlug, selectedClassRef);
    state.students = result.data.students || [];
    state.canManage = result.data.permissions?.canManage === true;
    const pendingResult = await state.api.provisionalStudents(state.activitySlug, $("teacher-class").value);
    state.pending = pendingResult.data.students || [];
    const classes = populateClasses(state.students);
    if (!state.classQueryResolved) {
      state.classQueryResolved = true;
      const classRef = resolveClassRef(classes, state.requestedClass);
      if (state.requestedClass && !classRef) {
        state.classQueryError = `Không tìm thấy lớp “${state.requestedClass}”. Dashboard đang hiển thị tất cả lớp.`;
      } else if (classRef && classRef !== selectedClassRef) {
        $("teacher-class").value = classRef;
        return refresh();
      }
    }
    renderSummary(state.students);
    renderStudents(state.students);
    renderReconciliation();
    $("teacher-login").hidden = true;
    $("teacher-dashboard").hidden = false;
    $("teacher-updated").textContent = `Cập nhật lúc ${formatTime(result.data.generatedAt)}`;
    showLoginError();
    showDashboardError(state.classQueryError);
    if ($("teacher-detail").open && state.selectedStudent && !$("teacher-detail").querySelector(".teacher-comment-composer textarea:focus, .teacher-comment-reply textarea:focus")) {
      const updated = state.students.find((student) => student.studentRef === state.selectedStudent.studentRef);
      if (updated) await loadStudentDetail({ ...state.selectedStudent, ...updated });
    }
  } catch (error) {
    const authFailure = teacherAuthFailure(error.status);
    if (authFailure) {
      state.token = "";
      $("teacher-dashboard").hidden = true;
      $("teacher-login").hidden = false;
      $("teacher-updated").textContent = authFailure.header;
      showLoginError(authFailure.message);
      globalThis.google?.accounts?.id?.disableAutoSelect?.();
      return;
    }
    if ($("teacher-dashboard").hidden) {
      showLoginError("Đã đăng nhập nhưng chưa thể tải dữ liệu lớp. Hệ thống sẽ tự thử lại.");
    } else {
      showDashboardError("Chưa thể cập nhật dữ liệu lớp. Hệ thống sẽ tự thử lại.");
    }
  }
  state.pollTimer = setTimeout(refresh, 5_000);
}

function handleCredential(response) {
  if (!response?.credential) return showLoginError("Không nhận được thông tin đăng nhập.");
  state.token = response.credential;
  $("teacher-login").hidden = false;
  $("teacher-dashboard").hidden = true;
  $("teacher-updated").textContent = "Đang xác minh quyền…";
  showLoginError("Đang xác minh quyền truy cập…");
  void refresh();
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
    state.requestedClass = classQuery(location.search);
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
    $("teacher-class").addEventListener("change", () => {
      state.classQueryError = "";
      void refresh();
    });
    $("teacher-export").addEventListener("click", async () => { const blob = await state.api.exportProgress(state.activitySlug, $("teacher-class").value); const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = `${state.activitySlug}-progress.csv`; link.click(); URL.revokeObjectURL(url); });
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
