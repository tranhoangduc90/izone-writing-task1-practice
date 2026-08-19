// Dữ liệu nhận vào: manifest Task 2 công khai, mã tình huống trên URL và dữ liệu giả cục bộ.
// Việc chính: dựng giao diện giống webapp, áp dụng điều kiện mở khóa và hiển thị Comment/từ vựng/LMS.
// Kết quả: người xem chuyển qua các kịch bản mà không tạo phiên học viên hoặc gọi n8n.
// Khi lỗi: trang hiện thông báo demo không tải được; không có dữ liệu thật nào bị thay đổi.
import { appendMarkdown } from "./markdown.js?v=20260818-numbering-v3";
import { sectionPrerequisitesPassed } from "./lesson-core.js";
import { renderLmsDraftResult } from "./lms-draft-result.js?v=20260818-numbering-v3";
import { createVocabularySection, manifestVocabularyRows } from "./vocabulary-ui.js?v=20260818-vocabulary-scroll";
import { task2DemoScenarios, task2DemoScenario, task2DemoTask } from "./task2-demo-data.js";

const $ = (id) => document.getElementById(id);
const statusLabels = {
  draft: "Chưa gửi",
  revision: "Cần sửa",
  queued: "Đang chấm",
  passed: "Đã đạt",
};

let manifest;
let scenario;

function meaningful(value) {
  return String(value || "").replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu, "");
}

function wordCount(values) {
  return values.join(" ").trim().split(/\s+/u).filter(Boolean).length;
}

function addGroup(root, title) {
  const group = document.createElement("div");
  group.className = "field-group-heading";
  const heading = document.createElement("h4");
  heading.textContent = title;
  group.append(heading);
  root.append(group);
}

function addChoice(root, field, value) {
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
    input.value = option.value;
    input.checked = value === option.value;
    input.disabled = true;
    const text = document.createElement("span");
    text.textContent = option.label;
    label.append(input, text);
    group.append(label);
  }
  root.append(group);
}

function addTextarea(root, field, value, locked) {
  const label = document.createElement("label");
  label.textContent = field.label;
  const textarea = document.createElement("textarea");
  textarea.name = field.key;
  textarea.rows = field.rows || 3;
  textarea.value = value || "";
  textarea.placeholder = field.placeholder || "";
  textarea.readOnly = true;
  textarea.disabled = locked;
  label.append(textarea);
  root.append(label);
}

function addFields(root, section, locked) {
  let currentGroup = "";
  const fields = section.fields || [];
  const draftFlow = section.flow?.type === "draft-revision";
  for (const [index, field] of fields.entries()) {
    if (field.group && field.group !== currentGroup) {
      currentGroup = field.group;
      addGroup(root, currentGroup);
    }
    const value = scenario.responses[field.key] || "";
    if (field.control === "choice") addChoice(root, field, value);
    else if (!draftFlow || index === 0 || meaningful(value)) addTextarea(root, field, value, locked);
  }
  if (draftFlow && !meaningful(scenario.responses.draft2)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "primary unlock-draft2";
    button.textContent = "Chuyển Draft 1 xuống Draft 2 và sửa";
    button.disabled = true;
    button.title = meaningful(scenario.responses.draft1)
      ? "Bản demo chỉ đọc; nút này hoạt động trong webapp thật"
      : "Nút sẽ mở khi Draft 1 có nội dung";
    const hint = document.createElement("p");
    hint.className = "muted draft-unlock-hint";
    hint.textContent = meaningful(scenario.responses.draft1)
      ? "Trong webapp thật, nút này đang sẵn sàng và sẽ sao chép nguyên văn Draft 1 để học viên tự sửa."
      : "Trong webapp thật, nút sẽ mở khi Draft 1 có nội dung.";
    root.append(button, hint);
  }
}

function renderComments(workspace, section, state) {
  const list = workspace.querySelector(".comment-list");
  const empty = workspace.querySelector(".empty-comments");
  if (section.key === "draft" && scenario.lmsResponse) {
    workspace.querySelector(".comments-panel").classList.add("draft-result-panel");
    list.classList.add("draft-result-list");
    const item = document.createElement("li");
    item.className = "draft-result-box";
    item.dataset.status = "completed";
    const result = document.createElement("div");
    result.className = "lms-inline-result";
    renderLmsDraftResult(result, scenario.lmsResponse, { updatedAt: "2026-08-19T10:30:00+07:00" });
    item.append(result);
    list.append(item);
    empty.hidden = true;
    return;
  }
  const comments = [...(state.comments || [])].reverse();
  for (const comment of comments) {
    const item = document.createElement("li");
    item.dataset.status = comment.status || "completed";
    const meta = document.createElement("div");
    meta.className = "comment-meta";
    meta.textContent = `Comment lần ${comment.commentNumber || 1}${comment.status === "queued" ? " · Đang chấm" : ""}`;
    const body = document.createElement("div");
    body.className = "comment-body markdown-body";
    appendMarkdown(body, comment.feedback || "Đã cập nhật trạng thái.");
    item.append(meta, body);
    if (comment.status === "technical_error" && comment.canRetry !== false) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "secondary compact";
      retry.textContent = "Thử lại";
      retry.disabled = true;
      retry.title = "Bản demo không gọi n8n";
      item.append(retry);
    }
    list.append(item);
  }
  empty.hidden = comments.length > 0;
  if (!comments.length && !sectionPrerequisitesPassed(section, scenario.sections)) {
    empty.textContent = "Phần này sẽ mở sau khi các bước trước đạt.";
  }
}

function renderSection(section) {
  const workspace = $("task2-demo-section-template").content.firstElementChild.cloneNode(true);
  const state = scenario.sections[section.key] || { status: "draft", comments: [] };
  const prerequisitesPassed = sectionPrerequisitesPassed(section, scenario.sections);
  const locked = !prerequisitesPassed || ["queued", "passed"].includes(state.status);
  workspace.dataset.section = section.key;
  workspace.dataset.state = state.status;
  workspace.querySelector(".section-kicker").textContent = section.kicker || "";
  workspace.querySelector(".section-heading h3").textContent = section.title;
  workspace.querySelector(".section-instruction").textContent = section.instruction || "";
  const badge = workspace.querySelector(".section-status");
  badge.dataset.state = state.status;
  badge.textContent = prerequisitesPassed ? statusLabels[state.status] || state.status : "Chờ phần trước";
  const fields = workspace.querySelector(".text-fields");
  addFields(fields, section, locked);
  const values = (section.fields || []).filter((field) => field.control !== "choice").map((field) => scenario.responses[field.key] || "");
  workspace.querySelector(".word-count").textContent = `${wordCount(values)} từ`;
  const button = workspace.querySelector(".submit-section");
  button.disabled = true;
  button.textContent = !prerequisitesPassed
    ? "Hoàn thành phần trước"
    : state.status === "passed"
      ? (section.key === "draft" ? "Đã có kết quả chấm" : "Phần này đã đạt")
      : state.status === "queued"
        ? "Đang chấm"
        : section.key === "draft"
          ? "Gửi chấm Draft"
          : "Check";
  workspace.querySelector(".comments-title").textContent = section.key === "draft" ? "Kết quả chấm Draft" : `Dòng thời gian · ${section.title}`;
  renderComments(workspace, section, state);
  return workspace;
}

function renderVocabulary(root) {
  const unlocked = ["topic_sentence", "supporting_idea_1", "supporting_idea_2"]
    .every((key) => scenario.sections[key]?.status === "passed");
  if (unlocked && scenario.vocabulary?.length) {
    const section = createVocabularySection(document, manifestVocabularyRows(scenario.vocabulary), {
      title: "Từ vựng gợi ý theo hai Idea",
      className: "card task2-draft-vocabulary",
      scrollHint: "Cuộn trong bảng để xem thêm. Phần Draft ở ngay bên dưới ↓",
    });
    root.append(section);
    return;
  }
  const section = document.createElement("section");
  section.className = "lesson-vocabulary card";
  const title = document.createElement("h3");
  title.textContent = "Từ vựng gợi ý theo hai Idea";
  const message = document.createElement("p");
  message.className = "muted";
  message.textContent = "Hoàn thành Topic Sentence và cả hai Supporting Ideas để mở bảng từ vựng.";
  section.append(title, message);
  root.append(section);
}

function renderScenarioNavigation() {
  const root = $("task2-demo-cases");
  for (const item of task2DemoScenarios) {
    const link = document.createElement("a");
    link.href = `./task2-demo.html?case=${encodeURIComponent(item.id)}`;
    link.textContent = item.shortLabel;
    if (item.id === scenario.id) link.setAttribute("aria-current", "page");
    root.append(link);
  }
}

function renderScenario() {
  $("task2-demo-case-title").textContent = scenario.title;
  $("task2-demo-case-description").textContent = scenario.description;
  appendMarkdown($("task2-demo-prompt"), task2DemoTask.statement);
  renderScenarioNavigation();
  const sections = new Map(manifest.sections.map((section) => [section.key, section]));
  const root = $("task2-demo-bodies");
  for (const body of manifest.bodies || []) {
    const bodyRoot = document.createElement("section");
    bodyRoot.className = "lesson-body-block";
    const header = document.createElement("header");
    header.className = "lesson-body-header";
    const title = document.createElement("h2");
    title.textContent = body.title;
    const description = document.createElement("p");
    description.textContent = body.description || "";
    header.append(title, description);
    bodyRoot.append(header);
    for (const sectionKey of body.sectionKeys || []) bodyRoot.append(renderSection(sections.get(sectionKey)));
    if (body.key === "preparation") renderVocabulary(bodyRoot);
    root.append(bodyRoot);
  }
}

async function start() {
  const requested = new URLSearchParams(window.location.search).get("case");
  scenario = task2DemoScenario(requested);
  const response = await fetch("./manifests/writing-task2-practice-template.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Không tải được manifest Task 2.");
  manifest = await response.json();
  renderScenario();
}

start().catch((error) => {
  const notice = $("task2-demo-note");
  notice.textContent = error.message || "Không thể mở bản demo Task 2.";
  notice.classList.add("form-error");
});
