import { createLessonApi } from "./api.js";
import { classQuery, resolveClassRef } from "./class-selection.js";
import { createRequestId, hasMeaningfulText, isConflict, pollingDelay, safeLmsUrl, terminalResult, wordCount } from "./core.js";
import { getDraft, getLatestDraft, putDraft } from "./idb.js";
import { claimSectionSubmission, fieldDefinitions, normalizeLessonProgress, sectionDefinitions, sectionIsFilled, sectionPrerequisitesPassed, sectionSubmitLabel, vocabularyPrerequisitesPassed } from "./lesson-core.js";
import { renderLmsDraftResult } from "./lms-draft-result.js?v=20260818-numbering-v3";
import { appendMarkdown } from "./markdown.js?v=20260818-numbering-v3";
import { renderStudentFieldComments } from "./teacher-comments-ui.js";
import { createVocabularySection, manifestVocabularyRows } from "./vocabulary-ui.js?v=20260818-vocabulary-scroll";

const $ = (id) => document.getElementById(id);
const app = {
  manifest: null,
  api: null,
  activitySlug: "",
  roster: null,
  identity: null,
  sessionRef: null,
  state: null,
  dirty: false,
  conflict: false,
  localTimer: null,
  remoteTimer: null,
  heartbeatTimer: null,
  pollTimer: null,
  activeField: null,
  changeSequence: 0,
  savingPromise: null,
  pendingAttempts: new Map(),
  submittingSections: new Set(),
  teacherComments: [],
  teacherCommentsEtag: null,
  teacherCommentTimer: null,
  draftResult: { key: null, status: "idle", data: null, pageIndex: 0 },
};

function setSaveState(value) { $("lesson-save-state").textContent = value; }
function showNotice(value = "") { const node = $("lesson-notice"); node.hidden = !value; node.textContent = value; }
function draftKey() { return `lesson:${app.activitySlug}:${app.identity?.classRef || ""}:${app.identity?.studentRef || ""}`; }
function statusLabel(status) { return ({ draft: "Chưa làm", queued: "Đang chấm", revision: "Cần sửa", passed: "Đã đạt" })[status] || "Chưa làm"; }
function sectionByKey(key) { return sectionDefinitions(app.manifest).find((section) => section.key === key); }
function serverUpdatedAt() { return app.state?.updatedAt ? Date.parse(app.state.updatedAt) : 0; }

async function loadManifest() {
  const slug = new URLSearchParams(location.search).get("task") || "writing-lesson13-young-leaders";
  const [manifestResponse, configResponse] = await Promise.all([
    fetch(`./manifests/${encodeURIComponent(slug)}.json`),
    fetch("./config.json", { cache: "no-store" }).catch(() => null),
  ]);
  if (!manifestResponse.ok) throw new Error("Không tìm thấy cấu hình handout.");
  app.manifest = await manifestResponse.json();
  app.activitySlug = app.manifest.activity?.slug || slug;
  const publicConfig = configResponse?.ok ? await configResponse.json() : {};
  app.api = createLessonApi(publicConfig.apiBase || "");
  const title = app.manifest.activity?.title || "Handout Writing";
  const eyebrow = app.manifest.activity?.eyebrow || "Writing Task 2";
  document.title = `${title} · iZONE`;
  $("lesson-setup-eyebrow").textContent = eyebrow;
  $("lesson-workspace-eyebrow").textContent = eyebrow;
  $("lesson-summary").textContent = title;
  $("lesson-title").textContent = title;
  $("lesson-prompt-title").textContent = app.manifest.task?.title || "Essay question";
  appendMarkdown($("lesson-prompt-text"), app.manifest.task?.statement || "");
}

function renderClassOptions() {
  for (const item of app.roster?.classes || []) {
    const option = document.createElement("option");
    option.value = item.classRef;
    option.textContent = item.className;
    $("lesson-class").append(option);
  }
}

function applyClassQuery() {
  const requested = classQuery(location.search);
  if (!requested) {
    updateStudentOptions();
    return;
  }
  const classRef = resolveClassRef(app.roster?.classes, requested);
  if (!classRef) {
    updateStudentOptions();
    const error = $("lesson-identity-error");
    error.hidden = false;
    error.textContent = `Không tìm thấy lớp “${requested}”. Hãy chọn lớp trong danh sách.`;
    return;
  }
  $("lesson-class").value = classRef;
  updateStudentOptions();
}

function studentsForClass(classRef) {
  return app.roster?.classes?.find((item) => item.classRef === classRef)?.students || [];
}

function updateStudentOptions() {
  const classRef = $("lesson-class").value;
  const select = $("lesson-student");
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Chọn họ và tên của bạn";
  select.append(placeholder);
  select.value = "";
  select.disabled = !classRef;
  for (const student of studentsForClass(classRef)) {
    const option = document.createElement("option");
    option.value = student.studentRef;
    option.textContent = student.alias || student.displayName;
    option.dataset.requiresAccessCode = student.requiresAccessCode ? "true" : "false";
    select.append(option);
  }
  $("lesson-access-code-row").hidden = true;
}

function selectedStudent() {
  const studentRef = $("lesson-student").value;
  const student = studentsForClass($("lesson-class").value).find((item) => item.studentRef === studentRef);
  return student ? { studentRef: student.studentRef, label: student.alias || student.displayName,
    provisional: Boolean(student.provisional), requiresAccessCode: Boolean(student.requiresAccessCode) } : null;
}

function updateAccessCode() {
  const student = selectedStudent();
  $("lesson-access-code-row").hidden = !student?.requiresAccessCode;
  if (!student?.requiresAccessCode) $("lesson-access-code").value = "";
}

async function createProvisionalStudent() {
  const error = $("lesson-identity-error"); const button = $("lesson-create-provisional");
  const classRef = $("lesson-class").value; const name = $("lesson-provisional-name").value;
  const pin = $("lesson-provisional-pin").value; const confirmPin = $("lesson-provisional-pin-confirm").value;
  if (!classRef) { error.hidden = false; error.textContent = "Hãy chọn lớp trước."; return; }
  if (!/^\d{4}$/.test(pin) || pin !== confirmPin) { error.hidden = false; error.textContent = "Hai ô mã phải giống nhau và gồm đúng 4 số."; return; }
  button.disabled = true;
  try {
    const result = await app.api.registerProvisional(app.activitySlug, classRef, name, pin, $("lesson-duplicate-confirm").checked, createRequestId());
    const student = result.data.student; const group = app.roster.classes.find((item) => item.classRef === classRef);
    group.students.push({ ...student, provisional: true, requiresAccessCode: true });
    updateStudentOptions(); $("lesson-student").value = student.studentRef; updateAccessCode(); $("lesson-access-code").value = pin;
    $("lesson-provisional-panel").hidden = true; error.hidden = false; error.textContent = "Đã tạo hồ sơ tạm. Hãy bấm Mở bài làm.";
  } catch (requestError) {
    if (requestError.data?.error === "PROVISIONAL_STUDENT_EXISTS" && requestError.data.current) {
      const existing = requestError.data.current; const group = app.roster.classes.find((item) => item.classRef === classRef);
      if (!group.students.some((item) => item.studentRef === existing.studentRef)) group.students.push({ ...existing, provisional: true, requiresAccessCode: true });
      updateStudentOptions(); $("lesson-student").value = existing.studentRef; updateAccessCode(); $("lesson-duplicate-confirm-row").hidden = false;
    }
    if (requestError.data?.error === "DUPLICATE_STUDENT_NAME") $("lesson-duplicate-confirm-row").hidden = false;
    error.hidden = false; error.textContent = requestError.message;
  } finally { button.disabled = false; }
}

function mergeServer(payload, preserveResponses = false) {
  const currentResponses = preserveResponses ? { ...app.state.responses } : null;
  const normalized = normalizeLessonProgress(payload, app.manifest);
  app.state = normalized;
  if (currentResponses) app.state.responses = currentResponses;
  for (const attempt of normalized.attempts) registerAttempt(attempt);
}

function markDirty() {
  app.dirty = true;
  app.changeSequence += 1;
  setSaveState("Có thay đổi chưa lưu");
  clearTimeout(app.localTimer);
  app.localTimer = setTimeout(saveLocal, 500);
  if (!app.remoteTimer) app.remoteTimer = setTimeout(() => {
    app.remoteTimer = null;
    saveRemote("auto").catch(() => {});
  }, 15_000);
}

async function saveLocal() {
  if (!app.state || !app.identity) return;
  await putDraft({ key: draftKey(), savedAt: Date.now(), sessionRef: app.sessionRef, identity: app.identity, progress: app.state });
}

async function restoreLocal() {
  const local = await getDraft(draftKey());
  if (!local?.progress || Number(local.savedAt || 0) <= serverUpdatedAt()) return;
  if (!confirm("Đã tìm thấy bản lưu mới hơn trên thiết bị. Khôi phục bản này?")) return;
  app.state = normalizeLessonProgress(local.progress, app.manifest);
  app.sessionRef = local.sessionRef || app.sessionRef;
  app.dirty = true;
  app.changeSequence += 1;
  showNotice("Đã khôi phục bản lưu trên thiết bị. Hãy lưu để đồng bộ lên hệ thống.");
}

async function saveRemote(reason = "manual") {
  if (app.savingPromise) {
    await app.savingPromise;
    return app.dirty ? saveRemote(reason) : true;
  }
  if (!app.dirty || app.conflict) return !app.conflict;
  clearTimeout(app.remoteTimer);
  app.remoteTimer = null;
  const sentSequence = app.changeSequence;
  const progress = { revision: app.state.revision, responses: { ...app.state.responses } };
  setSaveState(reason === "close" ? "Đang lưu trước khi đóng…" : "Đang lưu…");
  app.savingPromise = app.api.saveResponses(app.sessionRef, progress);
  try {
    const result = await app.savingPromise;
    const preserveResponses = app.changeSequence !== sentSequence;
    mergeServer(result.data.session || result.data, preserveResponses);
    app.dirty = preserveResponses;
    await saveLocal();
    setSaveState(preserveResponses ? "Có thay đổi chưa lưu" : `Đã lưu lúc ${new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`);
    if (preserveResponses && !app.remoteTimer) app.remoteTimer = setTimeout(() => { app.remoteTimer = null; saveRemote("auto").catch(() => {}); }, 15_000);
    return true;
  } catch (error) {
    if (isConflict(error)) {
      app.conflict = true;
      $("lesson-conflict").hidden = false;
      setSaveState("Cần xử lý xung đột bản lưu");
    } else {
      showNotice("Chưa thể lưu lên hệ thống. Bản trên thiết bị vẫn được giữ.");
      setSaveState("Chưa đồng bộ");
      if (app.dirty && !app.remoteTimer) {
        app.remoteTimer = setTimeout(() => {
          app.remoteTimer = null;
          saveRemote("auto").catch(() => {});
        }, 15_000);
      }
    }
    return false;
  } finally {
    app.savingPromise = null;
  }
}

function schedulePresence(activeField = app.activeField) {
  if (!app.sessionRef || document.hidden) return;
  app.api.publishLive(app.sessionRef, activeField).catch(() => {});
}

function addTextarea(card, section, field, locked) {
  const fieldRoot = document.createElement("div"); fieldRoot.className = "practice-field"; fieldRoot.dataset.fieldKey = field.key;
  const label = document.createElement("label");
  label.textContent = field.label;
  const textarea = document.createElement("textarea");
  textarea.name = field.key;
  textarea.rows = field.rows || 3;
  textarea.maxLength = 20_000;
  textarea.placeholder = field.placeholder || "";
  textarea.value = app.state.responses[field.key] || "";
  textarea.disabled = locked;
  const teacherComments = document.createElement("section"); teacherComments.className = "student-teacher-comments"; teacherComments.dataset.teacherCommentField = field.key;
  textarea.addEventListener("input", () => {
    app.state.responses[field.key] = textarea.value;
    markDirty();
    updateWordCount(card, section);
    renderTeacherCommentsForField(teacherComments, field.key);
  });
  textarea.addEventListener("focus", () => { app.activeField = field.key; schedulePresence(); });
  textarea.addEventListener("blur", () => {
    app.activeField = null;
    schedulePresence(null);
    if (app.dirty) saveRemote("field").catch(() => {});
  });
  label.append(textarea);
  fieldRoot.append(label, teacherComments);
  card.querySelector(".text-fields").append(fieldRoot);
  renderTeacherCommentsForField(teacherComments, field.key);
}

function addChoice(card, section, field, locked) {
  const group = document.createElement("fieldset");
  group.className = "choice-field";
  const legend = document.createElement("legend");
  legend.textContent = field.label;
  group.append(legend);
  for (const option of field.options || []) {
    const label = document.createElement("label");
    const input = document.createElement("input");
    input.type = "radio";
    input.name = field.key;
    input.value = String(option.value ?? "");
    input.checked = app.state.responses[field.key] === input.value;
    input.disabled = locked;
    input.addEventListener("change", () => {
      app.state.responses[field.key] = input.value;
      markDirty();
      updateWordCount(card, section);
    });
    const text = document.createElement("span");
    text.textContent = option.label || input.value;
    label.append(input, text);
    group.append(label);
  }
  card.querySelector(".text-fields").append(group);
}

function appendFieldGroup(card, title) {
  const heading = document.createElement("div");
  heading.className = "field-group-heading";
  const text = document.createElement("h4");
  text.textContent = title;
  heading.append(text);
  card.querySelector(".text-fields").append(heading);
}

function addField(card, section, field, locked) {
  if (field.control === "choice") addChoice(card, section, field, locked);
  else addTextarea(card, section, field, locked);
}

function renderDraftRevisionFields(card, section, locked) {
  if (section.guidance) {
    const guidance = document.createElement("div");
    guidance.className = "draft-guidance markdown-body";
    appendMarkdown(guidance, section.guidance);
    card.querySelector(".text-fields").append(guidance);
  }
  const [draft1Field, draft2Field] = section.fields || [];
  if (!draft1Field || !draft2Field) return;
  addTextarea(card, section, draft1Field, locked);
  const draft2Visible = hasMeaningfulText(app.state.responses[draft2Field.key]);
  if (!draft2Visible) {
    const unlock = document.createElement("button");
    unlock.type = "button";
    unlock.className = "primary unlock-draft2";
    unlock.textContent = "Chuyển Draft 1 xuống Draft 2 và sửa";
    unlock.disabled = locked || !hasMeaningfulText(app.state.responses[draft1Field.key]);
    unlock.addEventListener("click", () => {
      if (!hasMeaningfulText(app.state.responses[draft1Field.key])) return;
      app.state.responses[draft2Field.key] = app.state.responses[draft1Field.key];
      markDirty();
      renderBodies();
      document.querySelector(`textarea[name="${draft2Field.key}"]`)?.focus();
    });
    const hint = document.createElement("p");
    hint.className = "muted draft-unlock-hint";
    hint.textContent = "Nút chỉ mở khi Draft 1 có nội dung. Hệ thống sẽ sao chép nguyên văn để em tự sửa.";
    card.querySelector(".text-fields").append(unlock, hint);
    card.querySelector(`textarea[name="${draft1Field.key}"]`)?.addEventListener("input", () => {
      unlock.disabled = locked || !hasMeaningfulText(app.state.responses[draft1Field.key]);
    });
    return;
  }
  const banner = document.createElement("p");
  banner.className = "draft-copy-banner";
  banner.textContent = "Draft 1 đã được copy xuống. Hãy sửa Draft 2 thành tiếng Anh hoàn chỉnh rồi gửi chấm.";
  card.querySelector(".text-fields").append(banner);
  addTextarea(card, section, draft2Field, locked);
}

function renderTeacherCommentsForField(root, fieldKey) {
  renderStudentFieldComments(root, {
    fieldKey,
    text: app.state?.responses?.[fieldKey] || "",
    threads: app.teacherComments,
    onReply: async (thread, body) => {
      await app.api.replyTeacherComment(app.sessionRef, thread.threadRef, body);
      await refreshTeacherComments(true);
    },
  });
}

function renderTeacherCommentPanels() {
  for (const root of document.querySelectorAll("[data-teacher-comment-field]")) renderTeacherCommentsForField(root, root.dataset.teacherCommentField);
}

function scheduleTeacherComments() {
  clearTimeout(app.teacherCommentTimer);
  if (app.sessionRef && !document.hidden) app.teacherCommentTimer = setTimeout(() => refreshTeacherComments(), 15_000);
}

async function refreshTeacherComments(force = false) {
  clearTimeout(app.teacherCommentTimer);
  if (!app.sessionRef || document.hidden) return;
  if (!force && document.activeElement?.closest?.(".teacher-comment-reply")) { scheduleTeacherComments(); return; }
  try {
    const result = await app.api.teacherComments(app.sessionRef, force ? null : app.teacherCommentsEtag);
    if (!result.notModified) {
      app.teacherComments = result.data.threads || [];
      app.teacherCommentsEtag = result.etag || null;
      renderTeacherCommentPanels();
    }
  } catch { /* Comment trực tiếp độc lập; lỗi tải không được làm gián đoạn luồng Check. */ }
  scheduleTeacherComments();
}

function updateWordCount(card, section) {
  const text = (section.fields || []).filter((field) => field.control !== "choice").map((field) => app.state.responses[field.key] || "").join(" ");
  card.querySelector(".word-count").textContent = `${wordCount(text)} từ`;
}

function renderSection(section) {
  const workspace = $("lesson-section-template").content.firstElementChild.cloneNode(true);
  const card = workspace.querySelector(".section-card");
  const state = app.state.sections[section.key] || { status: "draft", attemptsWithoutPass: 0 };
  const prerequisitesPassed = sectionPrerequisitesPassed(section, app.state.sections);
  const submitting = app.submittingSections.has(section.key);
  const locked = submitting || ["queued", "passed"].includes(state.status) || !prerequisitesPassed;
  workspace.dataset.section = section.key;
  workspace.dataset.state = state.status;
  card.querySelector(".section-kicker").textContent = section.kicker || "";
  card.querySelector("h3").textContent = section.title;
  card.querySelector(".section-instruction").textContent = section.instruction || "";
  const badge = card.querySelector(".section-status");
  badge.textContent = prerequisitesPassed ? statusLabel(state.status) : "Chờ phần trước";
  badge.dataset.state = state.status;
  if (section.flow?.type === "draft-revision") renderDraftRevisionFields(card, section, locked);
  else {
    let currentGroup = "";
    for (const field of section.fields || []) {
      if (field.group && field.group !== currentGroup) {
        currentGroup = field.group;
        appendFieldGroup(card, currentGroup);
      }
      addField(card, section, field, locked);
    }
  }
  const button = card.querySelector(".submit-section");
  button.disabled = locked;
  if (section.flow?.type === "draft-revision") {
    const draft2Field = section.fields?.[1];
    button.hidden = !draft2Field || !hasMeaningfulText(app.state.responses[draft2Field.key]);
  }
  button.textContent = sectionSubmitLabel(section, state.status, submitting);
  button.addEventListener("click", () => submitSection(section, card));
  workspace.querySelector(".comments-title").textContent = section.flow?.type === "draft-revision" ? "Kết quả chấm Draft" : `Dòng thời gian · ${section.title}`;
  updateWordCount(card, section);
  renderSectionComments(workspace, section);
  return workspace;
}

function normalizeVocabularyRows(value, bodyKey) {
  const hasBodyGroups = value && typeof value === "object" && !Array.isArray(value)
    && (Object.hasOwn(value, "body1") || Object.hasOwn(value, "body2"));
  const raw = hasBodyGroups ? value?.[bodyKey] : value;
  if (Array.isArray(raw)) return raw.map((row) => ({ idea: row.idea || row.meaning || row.label || "", terms: row.terms || row.english || row.words || "" }));
  if (raw && typeof raw === "object") return Object.entries(raw).map(([idea, terms]) => ({ idea, terms: Array.isArray(terms) ? terms.join(", ") : String(terms || "") }));
  return [];
}

function latestVocabulary(bodyKey) {
  const comments = [...(app.state.comments || [])].reverse();
  for (const comment of comments) {
    const artifacts = comment.artifacts || {};
    const rows = normalizeVocabularyRows(artifacts.vocabulary || artifacts.vocabularyRows, bodyKey);
    if (rows.length) return rows;
  }
  return [];
}

function renderVocabulary(bodyRoot, bodyKey) {
  const unlocked = vocabularyPrerequisitesPassed(app.manifest.vocabulary, app.state.sections);
  const selectorField = app.manifest.vocabulary?.bodySelectorField;
  const selectedBody = selectorField ? app.state.responses?.[selectorField] : bodyKey;
  const rows = unlocked ? latestVocabulary(selectedBody) : [];
  if (!rows.length) {
    const section = document.createElement("section");
    section.className = "lesson-vocabulary card";
    const title = document.createElement("h3");
    title.textContent = app.manifest.vocabulary?.title || "Từ vựng hỗ trợ";
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = unlocked
      ? "Hệ thống chưa trả được bảng từ vựng. Hãy thử lại lượt Check lỗi kỹ thuật hoặc liên hệ giảng viên."
      : "Hoàn thành Topic Sentence và cả hai Supporting Ideas để mở bảng từ vựng.";
    section.append(title, empty);
    bodyRoot.append(section);
    return;
  }
  const section = createVocabularySection(document, manifestVocabularyRows(rows), {
    title: app.manifest.vocabulary?.title || "Từ vựng hỗ trợ",
    className: "card task2-draft-vocabulary",
    scrollHint: "Cuộn trong bảng để xem thêm. Phần Draft ở ngay bên dưới ↓",
  });
  if (section) bodyRoot.append(section);
}

function renderBodies() {
  const root = $("lesson-bodies");
  root.replaceChildren();
  for (const body of app.manifest.bodies || []) {
    const bodyRoot = document.createElement("section");
    bodyRoot.className = "lesson-body-block";
    bodyRoot.dataset.body = body.key;
    const header = document.createElement("header");
    header.className = "lesson-body-header";
    const title = document.createElement("h2"); title.textContent = body.title;
    const description = document.createElement("p"); description.textContent = body.description || "";
    header.append(title, description); bodyRoot.append(header);
    for (const sectionKey of body.sectionKeys || []) {
      const section = sectionByKey(sectionKey);
      if (section) bodyRoot.append(renderSection(section));
    }
    if (body.vocabulary !== false) renderVocabulary(bodyRoot, body.key);
    root.append(bodyRoot);
  }
  updatePollingStates();
}

function renderSectionComments(workspace, section) {
  const sectionComments = (app.state.comments || []).filter((item) => item.section === section.key);
  if (section.flow?.type === "draft-revision") {
    renderDraftResult(workspace, sectionComments);
    return;
  }
  const comments = sectionComments.slice().reverse();
  const list = workspace.querySelector(".comment-list");
  list.replaceChildren();
  for (const item of comments) {
    const li = document.createElement("li");
    li.dataset.status = item.status || "completed";
    const meta = document.createElement("div");
    meta.className = "comment-meta";
    meta.textContent = `Comment lần ${item.commentNumber || "?"}${item.status === "queued" ? " — Đang chấm" : ""} · ${item.createdAt ? new Date(item.createdAt).toLocaleString("vi-VN") : "Mới cập nhật"}`;
    const body = document.createElement("div");
    body.className = "comment-body markdown-body";
    appendMarkdown(body, item.feedback || "Đã cập nhật trạng thái chấm.");
    li.append(meta, body);
    if (item.status === "technical_error" && item.attemptRef && item.canRetry !== false) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "secondary compact";
      retry.textContent = "Thử lại";
      retry.addEventListener("click", () => retryAttempt(item, retry));
      li.append(retry);
    }
    list.append(li);
  }
  workspace.querySelector(".empty-comments").hidden = comments.length > 0;
}

function renderDraftResult(workspace, comments) {
  const panel = workspace.querySelector(".comments-panel");
  const list = workspace.querySelector(".comment-list");
  const empty = workspace.querySelector(".empty-comments");
  panel.classList.add("draft-result-panel");
  list.classList.add("draft-result-list");
  list.replaceChildren();
  const latest = comments.at(-1);
  if (!latest) {
    empty.hidden = false;
    empty.textContent = "Sau khi gửi Draft 2, kết quả chấm từng câu sẽ xuất hiện tại đây.";
    return;
  }
  empty.hidden = true;
  const item = document.createElement("li");
  item.className = "draft-result-box";
  item.dataset.status = latest.status || "completed";
  const meta = document.createElement("div");
  meta.className = "comment-meta";
  meta.textContent = latest.createdAt
    ? `Cập nhật ${new Date(latest.createdAt).toLocaleString("vi-VN")}`
    : "Kết quả Draft 2";
  const lmsUrl = safeLmsUrl(latest.artifacts?.lmsUrl || latest.feedback);
  if (lmsUrl) {
    const key = `${app.sessionRef}:${lmsUrl}`;
    const inline = document.createElement("div");
    inline.className = "lms-inline-result";
    item.append(meta, inline);
    if (app.draftResult.key !== key) {
      app.draftResult = { key, status: "loading", data: null, pageIndex: 0 };
      void app.api.draftResult(app.sessionRef).then(({ data }) => {
        if (app.draftResult.key !== key) return;
        app.draftResult = { key, status: "loaded", data: data.result, pageIndex: app.draftResult.pageIndex || 0 };
        renderBodies();
      }).catch(() => {
        if (app.draftResult.key !== key) return;
        app.draftResult = { key, status: "error", data: null, pageIndex: 0 };
        renderBodies();
      });
    }
    if (app.draftResult.status === "loaded") {
      renderLmsDraftResult(inline, app.draftResult.data, {
        updatedAt: app.draftResult.data?.updatedAt || latest.createdAt,
        initialIndex: app.draftResult.pageIndex,
        onPageChange: (pageIndex) => { app.draftResult.pageIndex = pageIndex; },
      });
    } else {
      const message = document.createElement("p");
      message.className = "draft-result-message";
      message.textContent = app.draftResult.status === "error"
        ? "Chưa tải được các thẻ nhận xét từ LMS."
        : "Đang tải các thẻ nhận xét…";
      inline.append(message);
    }
    const link = document.createElement("a");
    link.className = "lms-result-link lms-result-fallback";
    link.href = lmsUrl;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = app.draftResult.status === "error" ? "Mở kết quả trên LMS" : "Mở bản gốc trên LMS";
    item.append(link);
  } else {
    const message = document.createElement("p");
    message.className = "draft-result-message";
    message.textContent = latest.status === "queued"
      ? "Hệ thống đang chấm từng câu và tạo kết quả…"
      : latest.status === "technical_error"
        ? (latest.feedback || "Tạm thời chưa tạo được kết quả chấm.")
        : "Kết quả đã cập nhật nhưng chưa có dữ liệu LMS hợp lệ. Vui lòng báo giảng viên.";
    item.append(meta, message);
    if (latest.status === "technical_error" && latest.attemptRef && latest.canRetry !== false) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "secondary compact";
      retry.textContent = "Thử lại";
      retry.addEventListener("click", () => retryAttempt(latest, retry));
      item.append(retry);
    }
  }
  list.append(item);
}

function upsertComment(comment) {
  const index = app.state.comments.findIndex((item) => (comment.commentRef && item.commentRef === comment.commentRef) || (comment.attemptRef && item.attemptRef === comment.attemptRef));
  if (index >= 0) app.state.comments[index] = { ...app.state.comments[index], ...comment };
  else app.state.comments.push(comment);
}

async function submitSection(section, card) {
  const errorNode = card.querySelector(".field-error");
  if (!sectionIsFilled(section, app.state.responses)) {
    errorNode.hidden = false;
    errorNode.textContent = "Hãy hoàn thành các ô của phần này trước khi Check.";
    return;
  }
  if (!claimSectionSubmission(app.submittingSections, section.key)) return;
  errorNode.hidden = true;
  renderBodies();
  let previousStatus = app.state.sections[section.key].status;
  try {
    if (!(await saveRemote("check"))) return;
    previousStatus = app.state.sections[section.key].status;
    app.state.sections[section.key].status = "queued";
    renderBodies();
    const result = await app.api.checkSection(app.sessionRef, section.key);
    const attempt = result.data.attempt || result.data;
    registerAttempt(attempt);
    upsertComment({ commentRef: attempt.commentRef, attemptRef: attempt.attemptRef, section: section.key,
      commentNumber: attempt.commentNumber, status: "queued", feedback: "Đang chấm", createdAt: new Date().toISOString() });
    app.submittingSections.delete(section.key);
    setSaveState("Đã nhận Check — đang chấm, không cần bấm lại");
    renderBodies();
  } catch (error) {
    app.state.sections[section.key].status = previousStatus;
    renderBodies();
    const currentError = document.querySelector(`[data-section="${section.key}"] .field-error`);
    if (currentError) { currentError.hidden = false; currentError.textContent = error.message; }
  } finally {
    app.submittingSections.delete(section.key);
    if (!["queued", "passed"].includes(app.state.sections[section.key].status)) renderBodies();
  }
}

async function retryAttempt(comment, button) {
  button.disabled = true;
  try {
    const result = await app.api.retryAttempt(comment.attemptRef);
    const attempt = result.data.attempt || result.data;
    upsertComment({ ...comment, status: "queued", feedback: "Đang chấm" });
    app.state.sections[comment.section].status = "queued";
    registerAttempt(attempt);
    renderBodies();
  } catch (error) { showNotice(error.message); button.disabled = false; }
}

function registerAttempt(attempt) {
  const ref = attempt?.attemptRef || attempt?.id;
  if (!ref || terminalResult(attempt)) return;
  app.pendingAttempts.set(ref, { ref, section: attempt.section, etag: attempt.etag || null, submittedAt: Date.now() });
  schedulePoll();
}

function applyTerminalAttempt(payload, fallbackSection) {
  const section = payload.section || fallbackSection;
  const outcome = payload.resultStatus || payload.status;
  if (app.state.sections[section]) {
    app.state.sections[section].status = outcome === "passed" ? "passed" : "revision";
    app.state.sections[section].attemptsWithoutPass = Number(payload.attemptsWithoutPass || 0);
  }
  if (payload.comment || payload.feedback) upsertComment(payload.comment || { attemptRef: payload.attemptRef, section,
    commentNumber: payload.commentNumber, status: "completed", feedback: payload.feedback,
    artifacts: payload.artifacts || {}, createdAt: new Date().toISOString() });
  if (payload.supportWarning) showNotice("Cần liên hệ giảng viên để được hỗ trợ...");
  setSaveState("Đã nhận kết quả chấm");
}

function schedulePoll() {
  clearTimeout(app.pollTimer);
  updatePollingStates();
  if (document.hidden || !app.pendingAttempts.size) return;
  const earliest = Math.min(...[...app.pendingAttempts.values()].map((item) => item.submittedAt));
  app.pollTimer = setTimeout(pollAttempts, pollingDelay(Date.now() - earliest));
}

function updatePollingStates() {
  for (const section of sectionDefinitions(app.manifest)) {
    const node = document.querySelector(`[data-section="${section.key}"] .polling-state`);
    if (!node) continue;
    const active = [...app.pendingAttempts.values()].some((attempt) => attempt.section === section.key);
    node.textContent = active ? (document.hidden ? "Đã tạm dừng cập nhật" : "Đang chấm · thường 10–60 giây · không cần bấm lại") : "—";
  }
}

async function pollAttempts() {
  if (document.hidden) return schedulePoll();
  for (const attempt of [...app.pendingAttempts.values()]) {
    try {
      const result = await app.api.attempt(attempt.ref, attempt.etag);
      if (result.notModified) continue;
      const payload = result.data.attempt || result.data;
      attempt.etag = result.etag || attempt.etag;
      if (terminalResult(payload)) {
        app.pendingAttempts.delete(attempt.ref);
        applyTerminalAttempt(payload, attempt.section);
      }
    } catch (error) {
      if (error.status !== 304) showNotice("Đang chờ phản hồi chấm. Hệ thống sẽ tự thử lại.");
    }
  }
  renderBodies();
  schedulePoll();
}

async function openSession(event) {
  event.preventDefault();
  const student = selectedStudent();
  const classRef = $("lesson-class").value;
  const errorNode = $("lesson-identity-error");
  if (!classRef || !student) {
    errorNode.hidden = false;
    errorNode.textContent = "Hãy chọn đúng lớp và họ tên trong danh sách.";
    return;
  }
  errorNode.hidden = true;
  app.identity = { classRef, studentRef: student.studentRef, label: student.label };
  try {
    const accessCode = student.requiresAccessCode ? $("lesson-access-code").value : undefined;
    if (student.requiresAccessCode && !/^\d{4}$/.test(accessCode)) throw new Error("Hãy nhập đúng mã 4 số của hồ sơ tạm.");
    const opened = await app.api.createSession(app.activitySlug, classRef, student.studentRef, accessCode);
    app.sessionRef = (opened.data.session || opened.data).sessionRef;
    app.draftResult = { key: null, status: "idle", data: null, pageIndex: 0 };
    const result = await app.api.session(app.sessionRef);
    app.state = normalizeLessonProgress(result.data.session || result.data, app.manifest);
    await restoreLocal();
    $("lesson-student-label").textContent = `${student.label} · ${$("lesson-class").selectedOptions[0].textContent}`;
    $("lesson-setup").hidden = true;
    $("lesson-workspace").hidden = false;
    renderBodies();
    void refreshTeacherComments(true);
    setSaveState(app.dirty ? "Đã khôi phục bản lưu trên thiết bị" : "Đã tải bài làm");
    for (const attempt of app.state.attempts) registerAttempt(attempt);
    schedulePresence();
    app.heartbeatTimer = setInterval(schedulePresence, 30_000);
  } catch (error) {
    errorNode.hidden = false;
    errorNode.textContent = error.message;
  }
}

async function resumeRecent() {
  const local = await getLatestDraft(`lesson:${app.activitySlug}:`); if (!local) return;
  const errorNode = $("lesson-identity-error"); errorNode.hidden = true;
  try {
    app.identity = local.identity; app.sessionRef = local.sessionRef;
    const result = await app.api.session(app.sessionRef); app.state = normalizeLessonProgress(result.data.session || result.data, app.manifest); await restoreLocal();
    const className = app.roster.classes?.find(item => item.classRef === app.identity.classRef)?.className || "Lớp đã chọn";
    $("lesson-student-label").textContent = `${app.identity.label || "Bài gần nhất"} · ${className}`;
    $("lesson-setup").hidden = true; $("lesson-workspace").hidden = false; renderBodies(); void refreshTeacherComments(true);
    for (const attempt of app.state.attempts) registerAttempt(attempt); schedulePresence();
    clearInterval(app.heartbeatTimer); app.heartbeatTimer = setInterval(schedulePresence, 30_000);
  } catch (error) { errorNode.hidden = false; errorNode.textContent = `Chưa thể tiếp tục bài gần nhất: ${error.message}`; }
}

function saveWithKeepalive() {
  if (!app.dirty || !app.sessionRef || app.conflict) return;
  const payload = JSON.stringify({ baseVersion: app.state.revision, responses: app.state.responses, requestId: createRequestId() });
  fetch(app.api.beaconUrl(app.sessionRef), { method: "PUT", headers: { "content-type": "application/json", "if-match": String(app.state.revision) }, body: payload, keepalive: true }).catch(() => {});
}

async function init() {
  try {
    await loadManifest();
    const roster = await app.api.roster(app.activitySlug);
    app.roster = roster.data;
    renderClassOptions();
    applyClassQuery();
    $("lesson-resume-recent").hidden = !(await getLatestDraft(`lesson:${app.activitySlug}:`));
    $("lesson-class").addEventListener("change", updateStudentOptions);
    $("lesson-student").addEventListener("change", updateAccessCode);
    $("lesson-identity-form").addEventListener("submit", openSession);
    $("lesson-show-provisional").addEventListener("click", () => { $("lesson-provisional-panel").hidden = !$("lesson-provisional-panel").hidden; });
    $("lesson-create-provisional").addEventListener("click", createProvisionalStudent);
    $("lesson-resume-recent").addEventListener("click", resumeRecent);
    $("lesson-save").addEventListener("click", () => saveRemote("manual"));
    $("lesson-save-close").addEventListener("click", async () => {
      if (!(await saveRemote("close"))) return;
      window.close();
      setTimeout(() => showNotice("Đã lưu an toàn, bạn có thể đóng tab."), 250);
    });
    $("lesson-reload").addEventListener("click", () => location.reload());
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) { clearTimeout(app.pollTimer); clearTimeout(app.teacherCommentTimer); }
      else { schedulePoll(); schedulePresence(); refreshTeacherComments(); }
    });
    window.addEventListener("beforeunload", (event) => {
      if (!app.dirty) return;
      saveWithKeepalive();
      event.preventDefault();
      event.returnValue = "";
    });
  } catch (error) {
    $("lesson-summary").textContent = error.message;
    $("lesson-identity-form").querySelector("button").disabled = true;
    setSaveState("Không thể khởi động handout");
  }
}

init();
