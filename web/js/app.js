import { createApi } from "./api.js";
import { SECTION_KEYS, canUnlockDraft2, createRequestId, draftPrerequisitesPassed, hasMeaningfulText, isConflict, normalizeProgress, pollingDelay, safeHttpUrl, terminalResult, wordCount } from "./core.js";
import { getDraft, putDraft } from "./idb.js";
import { appendInlineMarkdown, appendMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);
const SECTION_INFO = {
  overview: { title: "Overview", kicker: "Phần 1", fields: [{ key: "overview", label: "Overview", placeholder: "Nêu những đặc điểm nổi bật nhất của biểu đồ…" }] },
  outline: { title: "Outline", kicker: "Phần 2", fields: [{ key: "body1", label: "Body 1", placeholder: "Nhóm số liệu thứ nhất…" }, { key: "body2", label: "Body 2", placeholder: "Nhóm số liệu thứ hai…" }] },
  draft: { title: "Draft 1 → Draft 2", kicker: "Phần 3", fields: [{ key: "draft1", label: "Draft 1", placeholder: "Viết liên tục phần Overview và Body 1…" }, { key: "draft2", label: "Draft 2", placeholder: "Sửa bản sao Draft 1 thành tiếng Anh hoàn chỉnh…" }] },
};
const app = { manifest: null, activitySlug: null, api: null, roster: null, identity: null, sessionRef: null, state: null, dirty: false, idbTimer: null, saveTimer: null, pollTimer: null, pendingAttempts: new Map(), conflict: false };

function setSaveState(text) { $("save-state").textContent = text; }
function showNotice(text = "") { const node = $("network-notice"); node.hidden = !text; node.textContent = text; }
function keyForDraft() { return `${app.activitySlug}:${app.identity?.classRef || ""}:${app.identity?.studentRef || ""}`; }
function statusLabel(state) { return ({ draft: "Chưa gửi", queued: "Đang chấm", revision: "Cần sửa", passed: "Đã đạt" })[state] || "Chưa gửi"; }
function sectionText(section) { return SECTION_INFO[section].fields.map(({ key }) => app.state.texts[key]).join("\n").trim(); }
function sectionContent(section) { return Object.fromEntries(SECTION_INFO[section].fields.map(({ key }) => [key, app.state.texts[key]])); }
function activeAttempts() { return [...app.pendingAttempts.values()]; }
function serverUpdatedAt() { return app.state?.updatedAt ? Date.parse(app.state.updatedAt) : 0; }

async function loadManifest() {
  const slug = new URLSearchParams(location.search).get("task") || "sample-task";
  const version = new URLSearchParams(location.search).get("version");
  const manifestPath = version
    ? `./manifests/${encodeURIComponent(slug)}/${encodeURIComponent(version)}.json`
    : `./manifests/${encodeURIComponent(slug)}.json`;
  const [response, configResponse] = await Promise.all([
    fetch(manifestPath),
    fetch("./config.json", { cache: "no-store" }).catch(() => null),
  ]);
  if (!response.ok) throw new Error("Không tìm thấy cấu hình bài luyện.");
  app.manifest = await response.json();
  app.activitySlug = app.manifest.activity?.slug || app.manifest.slug;
  if (!app.activitySlug) throw new Error("Cấu hình bài luyện thiếu mã hoạt động.");
  const publicConfig = configResponse?.ok ? await configResponse.json() : {};
  app.api = createApi(publicConfig.apiBase || app.manifest.apiBase || "");
  const title = app.manifest.activity?.title || app.manifest.title || "Bài luyện Writing Task 1";
  $("task-summary").textContent = title;
  $("task-title").textContent = title;
}

function renderClassOptions() {
  const select = $("class-id");
  const classes = app.roster?.classes || app.manifest.classes || [];
  for (const item of classes) {
    const option = document.createElement("option");
    option.value = item.ref || item.classRef || item.id;
    option.textContent = item.label || item.className || item.name;
    select.append(option);
  }
}

function addTextCard(root, title, value) {
  if (!value) return;
  const card = document.createElement("section"); const heading = document.createElement("h2"); const body = document.createElement("div"); body.className = "markdown-body";
  const normalized = typeof value === "object" && !Array.isArray(value)
    ? Object.entries(value).flatMap(([key, item]) => Array.isArray(item) ? item.map(entry => `${key}: ${entry}`) : [`${key}: ${item}`])
    : value;
  heading.textContent = title; appendMarkdown(body, Array.isArray(normalized) ? normalized.join("\n") : normalized); card.append(heading, body); root.append(card);
}

function addListCard(root, title, values) {
  const items = values.filter(Boolean); if (!items.length) return;
  const card = document.createElement("section"); const heading = document.createElement("h2"); const list = document.createElement("ul"); heading.textContent = title;
  for (const value of items) { const item = document.createElement("li"); appendInlineMarkdown(item, value); list.append(item); }
  card.append(heading, list); root.append(card);
}

function renderTaskContent() {
  const root = $("task-content"); root.replaceChildren(); const manifest = app.manifest; const task = manifest.task || manifest;
  addTextCard(root, "Đề bài", task.statement || task.taskStatement);
  const imageUrl = safeHttpUrl(task.chart_image?.url || task.chartImage || task.chartImageUrl || task.imageUrl);
  if (imageUrl) { const card = document.createElement("section"); const title = document.createElement("h2"); const link = document.createElement("a"); const image = document.createElement("img"); const hint = document.createElement("p"); card.className = "chart-card"; title.textContent = "Biểu đồ"; link.className = "chart-link"; link.href = imageUrl; link.target = "_blank"; link.rel = "noopener noreferrer"; image.src = imageUrl; image.alt = task.chart_image?.alt_text || task.chartAlt || "Biểu đồ của bài Writing Task 1"; image.decoding = "async"; hint.className = "chart-hint"; hint.textContent = "Nhấn vào ảnh để mở kích thước đầy đủ."; link.append(image); card.append(title, link, hint); root.append(card); }
  if (manifest.decoding && typeof manifest.decoding === "object") {
    addListCard(root, "Cách đọc dữ liệu", [
      manifest.decoding.what ? `Nội dung: ${manifest.decoding.what}` : "",
      manifest.decoding.unit ? `Đơn vị: ${manifest.decoding.unit}` : "",
      manifest.decoding.categories?.length ? `Nhóm dữ liệu: ${manifest.decoding.categories.join(", ")}` : "",
    ]);
  } else addTextCard(root, "Cách đọc dữ liệu", task.dataDecoding);
  if (Array.isArray(manifest.analysis?.bullets)) addListCard(root, "Gợi ý phân tích", manifest.analysis.bullets);
  else addTextCard(root, "Gợi ý phân tích", manifest.analysis || task.teacherAnalysis);
  const routes = manifest.routes || task.recommendedRoutes;
  if (Array.isArray(routes) && routes.length) {
    const card = document.createElement("section"); const heading = document.createElement("h2"); const list = document.createElement("ol"); heading.textContent = "Cách triển khai gợi ý";
    [...routes].sort((a, b) => Number(Boolean(b.recommended)) - Number(Boolean(a.recommended))).forEach((route) => { const item = document.createElement("li"); const details = route.body ? `${route.body.body_1 || ""} / ${route.body.body_2 || ""}` : route.description; const text = typeof route === "string" ? route : `${route.recommended ? "**Khuyến nghị:** " : ""}**${route.name || route.title || route.label || "Cách triển khai"}**${details ? ` — ${details}` : ""}`; appendInlineMarkdown(item, text); list.append(item); }); card.append(heading, list); root.append(card);
  }
  const manifestVocab = manifest.vocabulary;
  const vocab = Array.isArray(manifestVocab) ? manifestVocab : [
    ...(manifestVocab?.overview?.naming || []), ...(manifestVocab?.overview?.insights || []),
    ...(manifestVocab?.routes || []).flatMap(route => [...(route.naming || []), ...(route.story || [])])
  ];
  if (vocab.length) {
    const card = document.createElement("section"); const heading = document.createElement("h2"); const wrapper = document.createElement("div"); const table = document.createElement("table"); const thead = document.createElement("thead"); const tbody = document.createElement("tbody"); heading.textContent = "Từ vựng hỗ trợ"; wrapper.className = "table-scroll"; table.className = "vocab-table"; const headRow = document.createElement("tr"); ["Ý tiếng Việt", "Từ, cụm từ tiếng Anh"].forEach((label) => { const th = document.createElement("th"); th.scope = "col"; th.textContent = label; headRow.append(th); }); thead.append(headRow);
    vocab.forEach((entry) => { const row = document.createElement("tr"); const vi = document.createElement("td"); const en = document.createElement("td"); appendInlineMarkdown(vi, entry.vi || entry.meaning || entry.note || ""); appendInlineMarkdown(en, entry.en || entry.term || entry.title || entry.example || ""); row.append(vi, en); tbody.append(row); });
    table.append(thead, tbody); wrapper.append(table); card.append(heading, wrapper); root.append(card);
  }
  const rawChatbots = manifest.chatbots || task.chatbotLinks;
  const chatbots = Array.isArray(rawChatbots) ? rawChatbots : Object.values(rawChatbots || {}).filter(bot => bot.href);
  if (chatbots.length) {
    const card = document.createElement("section"); const heading = document.createElement("h2"); const list = document.createElement("ul"); heading.textContent = "Chatbot hỗ trợ";
    chatbots.forEach((bot) => { const href = safeHttpUrl(bot.url || bot.href); if (!href) return; const item = document.createElement("li"); const link = document.createElement("a"); link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = bot.title || bot.label || "Mở chatbot hỗ trợ"; item.append(link); list.append(item); }); if (list.children.length) { card.append(heading, list); root.append(card); }
  }
}

function studentsForClass(classRef) {
  const groups = app.roster?.classes || [];
  const group = groups.find((item) => (item.ref || item.classRef || item.id) === classRef);
  return group?.students || app.roster?.studentsByClass?.[classRef] || [];
}

function updateStudentOptions() {
  const classRef = $("class-id").value;
  const select = $("student-name");
  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Chọn họ và tên của bạn";
  select.append(placeholder);
  select.value = "";
  select.disabled = !classRef;
  for (const student of studentsForClass(classRef)) {
    const option = document.createElement("option");
    option.value = student.studentRef || student.ref;
    option.textContent = student.alias || student.name;
    select.append(option);
  }
}

function studentFromInput() {
  const studentRef = $("student-name").value;
  const student = studentsForClass($("class-id").value).find((item) => (item.studentRef || item.ref) === studentRef);
  return student ? { studentRef: student.studentRef || student.ref, label: student.alias || student.name } : null;
}

function mergeServer(payload) {
  const next = normalizeProgress(payload);
  next.updatedAt = payload.updatedAt || payload.updated_at || app.state?.updatedAt || null;
  app.state = { ...next, sections: { ...app.state?.sections, ...next.sections }, comments: next.comments.length ? next.comments : app.state?.comments || [] };
  for (const attempt of next.attempts) registerAttempt(attempt);
}

function addDraftGuidance(card) {
  const guidance = document.createElement("div"); guidance.className = "draft-guidance markdown-body";
  appendMarkdown(guidance, [
    "### Cách làm Draft",
    "Viết liên tục **Overview và Body 1**, không tra từ. Ở Draft 1, nếu thiếu từ, em có thể viết tiếng Việt hoặc tiếng Anh cơ bản rồi bọc phần đó trong `<...>`.",
    "**Ví dụ mẫu**",
    "> **Draft 1:** The percentage for one group was `<cao hơn rõ rệt>` than the corresponding figures.\n>\n> **Draft 2:** The percentage for one group was considerably higher than the corresponding figures.",
  ].join("\n\n"));
  card.querySelector(".text-fields").before(guidance);
}

function addTextarea(card, section, field, disabled) {
  const label = document.createElement("label"); label.textContent = field.label;
  const textarea = document.createElement("textarea"); textarea.name = field.key; textarea.rows = section === "overview" ? 7 : section === "draft" ? 10 : 5; textarea.maxLength = 5000; textarea.placeholder = field.placeholder; textarea.value = app.state.texts[field.key]; textarea.disabled = disabled;
  textarea.addEventListener("input", () => {
    app.state.texts[field.key] = textarea.value; markDirty(); refreshSection(card, section);
    const unlock = card.querySelector(".unlock-draft2"); if (unlock) unlock.disabled = disabled || !canUnlockDraft2(app.state.texts);
  });
  label.append(textarea); card.querySelector(".text-fields").append(label);
}

function renderDraftFields(card, locked, prerequisitesPassed) {
  addDraftGuidance(card);
  if (!prerequisitesPassed) {
    const notice = document.createElement("p"); notice.className = "draft-prerequisite"; notice.textContent = "Hãy hoàn thành và đạt Overview cùng Outline. Sau đó ô Draft 1 sẽ tự mở."; card.querySelector(".text-fields").append(notice); return;
  }
  addTextarea(card, "draft", SECTION_INFO.draft.fields[0], locked);
  if (!app.state.draft2Unlocked) {
    const unlock = document.createElement("button"); unlock.type = "button"; unlock.className = "primary unlock-draft2"; unlock.textContent = "Chuyển Draft 1 xuống Draft 2 và sửa"; unlock.disabled = locked || !canUnlockDraft2(app.state.texts);
    unlock.addEventListener("click", () => {
      if (!canUnlockDraft2(app.state.texts)) return;
      app.state.texts.draft2 = app.state.texts.draft1; app.state.draft2Unlocked = true; markDirty(); renderAll(); document.querySelector('textarea[name="draft2"]')?.focus();
    });
    const hint = document.createElement("p"); hint.className = "muted draft-unlock-hint"; hint.textContent = "Nút này chỉ mở khi Draft 1 có nội dung. Hệ thống sẽ sao chép nguyên văn để em chỉnh sửa.";
    card.querySelector(".text-fields").append(unlock, hint); return;
  }
  const banner = document.createElement("p"); banner.className = "draft-copy-banner"; banner.textContent = "Draft 1 đã được copy xuống. Hãy sửa Draft 2 thành tiếng Anh hoàn chỉnh rồi Check."; card.querySelector(".text-fields").append(banner);
  addTextarea(card, "draft", SECTION_INFO.draft.fields[1], locked);
}

function renderSections() {
  const root = $("sections"); const template = $("section-template"); root.replaceChildren();
  for (const section of SECTION_KEYS) {
    const info = SECTION_INFO[section]; const workspace = template.content.firstElementChild.cloneNode(true); const card = workspace.querySelector(".section-card"); const status = card.querySelector(".section-status");
    workspace.dataset.section = section; workspace.dataset.state = app.state.sections[section].status; card.dataset.section = section; card.querySelector(".section-kicker").textContent = info.kicker; card.querySelector("h2").textContent = info.title;
    const commentsTitle = workspace.querySelector(".comments-title"); commentsTitle.id = `comments-title-${section}`; commentsTitle.textContent = section === "draft" ? "Dòng thời gian Draft 1" : `Dòng thời gian ${info.title}`; workspace.querySelector(".comments-panel").setAttribute("aria-labelledby", commentsTitle.id);
    const prerequisitesPassed = section !== "draft" || draftPrerequisitesPassed(app.state.sections); const locked = ["passed", "queued"].includes(app.state.sections[section].status) || !prerequisitesPassed;
    status.textContent = section === "draft" && !prerequisitesPassed ? "Chờ phần trước" : statusLabel(app.state.sections[section].status); status.dataset.state = app.state.sections[section].status;
    if (section === "draft") renderDraftFields(card, locked, prerequisitesPassed);
    else for (const field of info.fields) addTextarea(card, section, field, locked);
    const button = card.querySelector(".submit-section"); button.hidden = section === "draft" && !app.state.draft2Unlocked; button.disabled = locked; button.textContent = app.state.sections[section].status === "queued" ? "Đang chấm" : locked && app.state.sections[section].status === "passed" ? "Phần này đã đạt" : section === "draft" ? "Check Draft 2" : "Gửi để nhận xét"; button.addEventListener("click", () => submitSection(section, card));
    refreshSection(card, section); root.append(workspace);
  }
}

function refreshSection(card, section) { card.querySelector(".word-count").textContent = `${wordCount(sectionText(section))} từ`; }
function renderComments() {
  const comments = app.state.comments || [];
  for (const section of SECTION_KEYS) {
    const workspace = document.querySelector(`.section-workspace[data-section="${section}"]`); if (!workspace) continue;
    const list = workspace.querySelector(".comment-list"); const sectionComments = comments.filter((item) => item.section === section); list.replaceChildren();
    for (const item of sectionComments.slice().reverse()) {
      const li = document.createElement("li"); const meta = document.createElement("div"); const body = document.createElement("div"); meta.className = "comment-meta"; body.className = "comment-body markdown-body"; li.dataset.status = item.status || "completed";
      const number = item.commentNumber ? `Comment lần ${item.commentNumber}` : "Comment"; const pending = item.status === "queued" ? " — Đang chấm" : "";
      meta.textContent = `${number}${pending} · ${item.createdAt ? new Date(item.createdAt).toLocaleString("vi-VN") : "Mới cập nhật"}`;
      appendMarkdown(body, item.feedback || item.message || item.text || "Đã cập nhật trạng thái chấm."); li.append(meta, body);
      if (item.status === "technical_error" && item.attemptRef && item.canRetry !== false) {
        const retry = document.createElement("button"); retry.type = "button"; retry.className = "button secondary compact"; retry.textContent = "Thử lại";
        retry.addEventListener("click", () => retryComment(item, retry)); li.append(retry);
      }
      list.append(li);
    }
    workspace.querySelector(".empty-comments").hidden = sectionComments.length > 0;
  }
}

function renderAll() { renderSections(); renderComments(); updatePollingStates(); }
function resetAutosave() { clearTimeout(app.saveTimer); if (app.dirty) app.saveTimer = setTimeout(async () => { await saveRemote("timer"); resetAutosave(); }, 10 * 60 * 1000); }
function markDirty() { const wasClean = !app.dirty; app.dirty = true; setSaveState("Có thay đổi chưa lưu"); clearTimeout(app.idbTimer); app.idbTimer = setTimeout(saveLocal, 500); if (wasClean) resetAutosave(); }
async function saveLocal() { if (!app.identity || !app.state) return; await putDraft({ key: keyForDraft(), savedAt: Date.now(), progress: app.state, sessionRef: app.sessionRef, identity: app.identity }); }

async function restoreLocal() {
  const draft = await getDraft(keyForDraft());
  if (!draft?.progress) return;
  const localIsNewer = Number(draft.savedAt || 0) > serverUpdatedAt();
  if (localIsNewer && confirm("Đã tìm thấy bản lưu cục bộ. Khôi phục bản này?")) { const restored = normalizeProgress(draft.progress); restored.updatedAt = draft.progress.updatedAt || app.state.updatedAt; app.state = restored; app.sessionRef = draft.sessionRef || app.sessionRef; app.dirty = true; showNotice("Đã khôi phục bản lưu trên thiết bị. Hãy lưu ngay để đồng bộ."); }
}

async function saveRemote(reason = "manual") {
  if (!app.dirty || app.conflict) return true;
  setSaveState(reason === "close" ? "Đang lưu trước khi đóng…" : "Đang lưu…");
  try {
    const result = await app.api.saveDraft(app.sessionRef, app.state);
    mergeServer(result.data.session || result.data); app.dirty = false; resetAutosave(); await saveLocal(); setSaveState(`Đã lưu lúc ${new Date().toLocaleTimeString("vi-VN", { hour: "2-digit", minute: "2-digit" })}`); renderAll(); return true;
  } catch (error) {
    if (isConflict(error)) { app.conflict = true; $("conflict-card").hidden = false; setSaveState("Cần xử lý xung đột bản lưu"); return false; }
    showNotice("Chưa thể lưu vào hệ thống. Bản trên thiết bị vẫn được giữ và sẽ thử lại khi bạn lưu."); setSaveState("Chưa đồng bộ"); return false;
  }
}

async function submitSection(section, card) {
  const content = sectionContent(section); const filled = section === "overview" ? hasMeaningfulText(content.overview) : section === "outline" ? Object.values(content).some(hasMeaningfulText) : app.state.draft2Unlocked && Object.values(content).every(hasMeaningfulText);
  const errorNode = card.querySelector(".field-error"); errorNode.hidden = filled;
  if (!filled) { errorNode.textContent = section === "overview" ? "Bạn cần viết Overview trước khi gửi." : section === "outline" ? "Bạn cần viết ít nhất một trong hai ô Body trước khi gửi." : "Bạn cần hoàn thành Draft 1, mở Draft 2 và sửa Draft 2 trước khi Check."; return; }
  if (!(await saveRemote("check"))) return;
  const previousStatus = app.state.sections[section].status;
  app.state.sections[section].status = "queued";
  renderAll();
  try {
    const snapshot = { overview: app.state.texts.overview, body1: app.state.texts.body1, body2: app.state.texts.body2, draft1: app.state.texts.draft1, draft2: app.state.texts.draft2 };
    const result = await app.api.checkSection(app.sessionRef, section, snapshot, app.state.revision);
    const attempt = result.data.attempt || result.data;
    if (terminalResult(attempt)) { applyTerminalAttempt(attempt, section); renderAll(); return; }
    app.state.sections[section].status = "queued"; registerAttempt(attempt); resetAutosave(); renderAll();
    const number = attempt.attemptNumber || attempt.commentNumber || attempt.sequence || app.state.sections[section].attemptsWithoutPass + 1;
    upsertComment({ commentRef: attempt.commentRef, attemptRef: attempt.attemptRef, section, commentNumber: number, status: "queued", feedback: "Đang chấm", createdAt: new Date().toISOString() });
    renderComments(); setSaveState("Đã bắt đầu check...");
  } catch (error) {
    app.state.sections[section].status = previousStatus;
    renderAll();
    if (isConflict(error)) { app.conflict = true; $("conflict-card").hidden = false; }
    else { const currentError = document.querySelector(`[data-section="${section}"] .field-error`); if (currentError) { currentError.hidden = false; currentError.textContent = error.message; } }
  }
}

function upsertComment(comment) {
  const comments = app.state.comments;
  const index = comments.findIndex((item) =>
    (comment.commentRef && item.commentRef === comment.commentRef)
    || (comment.attemptRef && item.attemptRef === comment.attemptRef));
  if (index >= 0) comments[index] = { ...comments[index], ...comment };
  else comments.push(comment);
}

async function retryComment(comment, button) {
  button.disabled = true; button.textContent = "Đang thử lại…";
  try {
    const result = await app.api.retryAttempt(comment.attemptRef); const attempt = result.data.attempt || result.data;
    upsertComment({ ...comment, status: "queued", feedback: "Đang chấm" });
    app.state.sections[comment.section].status = "queued"; registerAttempt(attempt); renderAll(); setSaveState("Đã bắt đầu check...");
  } catch (error) { showNotice(error.message); button.disabled = false; button.textContent = "Thử lại"; }
}

function registerAttempt(attempt) {
  const ref = attempt?.attemptRef || attempt?.ref || attempt?.id; if (!ref || terminalResult(attempt)) return;
  app.pendingAttempts.set(ref, { ref, etag: attempt.etag || null, submittedAt: Date.now(), section: attempt.section }); schedulePoll();
}

function applyTerminalAttempt(payload, fallbackSection) {
  const section = payload.section || fallbackSection; const outcome = payload.resultStatus || payload.status;
  if (section && app.state.sections[section]) {
    app.state.sections[section].status = outcome === "passed" ? "passed" : Number(payload.attemptsWithoutPass || 0) > 0 ? "revision" : "draft";
    app.state.sections[section].attemptsWithoutPass = payload.attemptsWithoutPass ?? app.state.sections[section].attemptsWithoutPass;
    if (payload.supportWarning) showNotice("Cần liên hệ giảng viên để được hỗ trợ...");
  }
  if (payload.comment || payload.feedback) upsertComment(payload.comment || { attemptRef: payload.attemptRef, section, commentNumber: payload.commentNumber, feedback: payload.feedback, createdAt: new Date().toISOString() });
  setSaveState("Đã nhận kết quả chấm");
}

function schedulePoll() {
  clearTimeout(app.pollTimer);
  updatePollingStates();
  if (document.hidden || !activeAttempts().length) return;
  const earliest = Math.min(...activeAttempts().map((item) => item.submittedAt)); const wait = pollingDelay(Date.now() - earliest);
  app.pollTimer = setTimeout(pollAttempts, wait);
}

function updatePollingStates() {
  for (const section of SECTION_KEYS) {
    const node = document.querySelector(`.section-workspace[data-section="${section}"] .polling-state`); if (!node) continue;
    const active = activeAttempts().some((item) => item.section === section);
    node.textContent = active ? (document.hidden ? "Đã tạm dừng" : "Đang chấm") : "—"; node.dataset.state = active && !document.hidden ? "polling" : "idle";
  }
}

async function pollAttempts() {
  if (document.hidden) return schedulePoll();
  for (const attempt of activeAttempts()) {
    try {
      const result = await app.api.attempt(attempt.ref, attempt.etag);
      if (result.notModified) continue;
      const payload = result.data.attempt || result.data; attempt.etag = result.etag || attempt.etag;
      if (terminalResult(payload)) {
        app.pendingAttempts.delete(attempt.ref); applyTerminalAttempt(payload, attempt.section);
      }
    } catch (error) { if (error.status !== 304) showNotice("Đang chờ phản hồi chấm. Hệ thống sẽ tự thử lại."); }
  }
  renderAll(); schedulePoll();
}

async function openSession(event) {
  event.preventDefault(); const classRef = $("class-id").value; const student = studentFromInput(); const error = $("identity-error");
  if (!classRef || !student) { error.hidden = false; error.textContent = "Hãy chọn đúng lớp và tên có trong danh sách."; return; }
  error.hidden = true; app.identity = { classRef, studentRef: student.studentRef, label: student.label };
  try {
    const result = await app.api.createSession(app.activitySlug, classRef, student.studentRef); const payload = result.data.session || result.data;
    app.sessionRef = payload.sessionRef || payload.ref || payload.id;
    if (!app.sessionRef) throw new Error("API không trả mã phiên làm bài.");
    const session = await app.api.session(app.sessionRef); app.state = normalizeProgress(session.data.session || session.data); app.state.updatedAt = session.data.updatedAt || session.data.session?.updatedAt || null; await restoreLocal();
    $("student-label").textContent = `${student.label} · ${$("class-id").selectedOptions[0].textContent}`; $("setup-card").hidden = true; $("workspace").hidden = false; renderAll(); setSaveState(app.dirty ? "Đã khôi phục bản lưu cục bộ" : "Đã tải bài làm");
    renderTaskContent(); for (const attempt of app.state.attempts) registerAttempt(attempt); schedulePoll();
  } catch (requestError) { error.hidden = false; error.textContent = requestError.message; }
}

function closeWithKeepalive() {
  if (!app.dirty || !app.sessionRef || app.conflict) return;
  const payload = JSON.stringify({ baseVersion: app.state.revision, overview: app.state.texts.overview, body1: app.state.texts.body1, body2: app.state.texts.body2, draft1: app.state.texts.draft1, draft2: app.state.texts.draft2, draft2Unlocked: app.state.draft2Unlocked, requestId: createRequestId() });
  fetch(app.api.beaconUrl(app.sessionRef), { method: "PUT", headers: { "content-type": "application/json", ...(app.state.revision == null ? {} : { "if-match": String(app.state.revision) }) }, body: payload, keepalive: true }).catch(() => {});
}

async function init() {
  try {
    await loadManifest(); const roster = await app.api.roster(app.activitySlug); app.roster = roster.data; renderClassOptions();
    $("class-id").addEventListener("change", updateStudentOptions); $("identity-form").addEventListener("submit", openSession);
    $("manual-save").addEventListener("click", () => saveRemote()); $("save-close").addEventListener("click", async () => { if (!(await saveRemote("close"))) return; window.close(); setTimeout(() => showNotice("Đã lưu an toàn, bạn có thể đóng tab"), 250); });
    $("reload-server").addEventListener("click", () => location.reload()); $("keep-local").addEventListener("click", () => { app.conflict = false; $("conflict-card").hidden = true; showNotice("Bản cục bộ vẫn an toàn. Hãy tải bản mới nhất để so sánh trước khi lưu lại."); });
    document.addEventListener("visibilitychange", () => document.hidden ? clearTimeout(app.pollTimer) : schedulePoll());
    window.addEventListener("beforeunload", (event) => { if (app.dirty) { closeWithKeepalive(); event.preventDefault(); event.returnValue = ""; } });
  } catch (error) { $("task-summary").textContent = error.message; $("identity-form").querySelector("button").disabled = true; setSaveState("Không thể khởi động bài luyện"); }
}
init();
