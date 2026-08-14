// Dữ liệu nhận vào: manifest công khai của Lesson 13 và bộ dữ liệu minh hoạ giả.
// Việc chính: dựng sáu section, câu trả lời, lịch sử góp ý Markdown và bảng từ vựng.
// Kết quả: một bản demo hoàn chỉnh chỉ đọc, không gọi API, database hoặc AI.
// Khi lỗi: hiện thông báo dễ hiểu ngay trên trang; bài làm thật không bị ảnh hưởng.
import { appendMarkdown } from "./markdown.js";
import { completedLessonDemo } from "./lesson-completed-demo-data.js";

const $ = (id) => document.getElementById(id);

function countWords(values) {
  return values.join(" ").trim().split(/\s+/u).filter(Boolean).length;
}

function addField(root, field) {
  const label = document.createElement("label");
  label.textContent = field.label;
  const textarea = document.createElement("textarea");
  textarea.name = field.key;
  textarea.rows = field.rows || 3;
  textarea.value = completedLessonDemo.responses[field.key] || "";
  textarea.readOnly = true;
  label.append(textarea);
  root.append(label);
}

function renderComments(workspace, section) {
  const comments = completedLessonDemo.comments[section.key] || [];
  const list = workspace.querySelector(".comment-list");
  [...comments].reverse().forEach((feedback, index) => {
    const li = document.createElement("li");
    li.dataset.status = "completed";
    const meta = document.createElement("div");
    meta.className = "comment-meta";
    meta.textContent = `Comment lần ${comments.length - index} · ${index === 0 ? "Đã đạt" : "Cần sửa"}`;
    const body = document.createElement("div");
    body.className = "comment-body markdown-body";
    appendMarkdown(body, feedback);
    li.append(meta, body);
    list.append(li);
  });
}

function renderSection(section) {
  const workspace = $("demo-section-template").content.firstElementChild.cloneNode(true);
  workspace.dataset.section = section.key;
  workspace.querySelector(".section-kicker").textContent = section.kicker;
  workspace.querySelector(".section-heading h3").textContent = section.title;
  workspace.querySelector(".section-instruction").textContent = section.instruction;
  workspace.querySelector(".comments-title").textContent = `Dòng thời gian · ${section.title}`;
  const fields = workspace.querySelector(".text-fields");
  for (const field of section.fields || []) addField(fields, field);
  const values = (section.fields || []).map((field) => completedLessonDemo.responses[field.key] || "");
  workspace.querySelector(".word-count").textContent = `${countWords(values)} từ`;
  renderComments(workspace, section);
  return workspace;
}

function renderVocabulary() {
  const root = $("demo-vocabulary-body");
  for (const [idea, terms] of completedLessonDemo.vocabulary) {
    const row = document.createElement("tr");
    const ideaCell = document.createElement("td");
    const termsCell = document.createElement("td");
    ideaCell.textContent = idea;
    termsCell.textContent = terms;
    row.append(ideaCell, termsCell);
    root.append(row);
  }
}

async function start() {
  const response = await fetch("./manifests/writing-lesson13-young-leaders.json", { cache: "no-store" });
  if (!response.ok) throw new Error("Không tải được nội dung Lesson 13.");
  const manifest = await response.json();
  appendMarkdown($("demo-prompt"), manifest.task.statement);
  const sections = new Map(manifest.sections.map((section) => [section.key, section]));
  for (const body of manifest.bodies) {
    const bodyRoot = document.createElement("section");
    bodyRoot.className = "lesson-body-block";
    const header = document.createElement("header");
    header.className = "lesson-body-header";
    const title = document.createElement("h2");
    const description = document.createElement("p");
    title.textContent = body.title;
    description.textContent = body.description;
    header.append(title, description);
    bodyRoot.append(header);
    for (const sectionKey of body.sectionKeys) bodyRoot.append(renderSection(sections.get(sectionKey)));
    $("demo-bodies").append(bodyRoot);
  }
  renderVocabulary();
}

start().catch((error) => {
  const notice = document.querySelector(".lesson-demo-note");
  notice.textContent = error.message || "Không thể mở bản demo.";
  notice.classList.add("form-error");
});
