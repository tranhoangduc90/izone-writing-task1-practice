import { annotatedSegments, threadsForField } from "./teacher-comments-core.js";

function formatDate(value) {
  return value ? new Date(value).toLocaleString("vi-VN") : "Mới cập nhật";
}

export function renderAnnotatedText(root, text, threads, onOpenThread = () => {}) {
  root.replaceChildren();
  for (const segment of annotatedSegments(text, threads)) {
    if (!segment.threadRefs.length) { root.append(document.createTextNode(segment.text)); continue; }
    const mark = document.createElement("mark"); mark.className = "teacher-comment-highlight"; mark.textContent = segment.text;
    mark.tabIndex = 0; mark.setAttribute("role", "button"); mark.title = "Mở comment của giảng viên";
    const open = () => onOpenThread(segment.threadRefs[0]);
    mark.addEventListener("click", open);
    mark.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); open(); } });
    root.append(mark);
  }
}

export function createTeacherCommentThreadCard(thread, { allowReply = true, allowStatus = false, onReply = async () => {}, onStatus = async () => {} } = {}) {
  const card = document.createElement("article"); card.className = "teacher-comment-thread"; card.dataset.threadRef = thread.threadRef; card.dataset.status = thread.status || "open";
  const header = document.createElement("div"); header.className = "teacher-comment-thread-header";
  const quote = document.createElement("blockquote"); quote.textContent = thread.anchor?.quote || "Đoạn được nhận xét";
  const status = document.createElement("span"); status.className = "teacher-comment-status";
  status.textContent = thread.status === "addressed" ? "Đã xử lý · vẫn lưu trong lịch sử" : "Đang trao đổi";
  header.append(quote, status); card.append(header);
  if (thread.anchor?.detached) {
    const detached = document.createElement("p"); detached.className = "teacher-comment-detached";
    detached.textContent = "Đoạn gốc đã được sửa hoặc di chuyển; comment vẫn được giữ lại."; card.append(detached);
  }
  const messages = document.createElement("ol"); messages.className = "teacher-comment-messages";
  for (const message of thread.messages || []) {
    const item = document.createElement("li"); item.dataset.authorRole = message.authorRole;
    const meta = document.createElement("div"); meta.className = "teacher-comment-message-meta";
    meta.textContent = `${message.authorLabel || (message.authorRole === "teacher" ? "Giảng viên" : "Học viên")} · ${formatDate(message.createdAt)}`;
    const body = document.createElement("p"); body.textContent = message.body || "";
    item.append(meta, body); messages.append(item);
  }
  card.append(messages);
  if (allowReply) {
    const form = document.createElement("form"); form.className = "teacher-comment-reply";
    const input = document.createElement("textarea"); input.rows = 2; input.maxLength = 5000; input.placeholder = "Trả lời comment…"; input.setAttribute("aria-label", "Trả lời comment");
    const submit = document.createElement("button"); submit.type = "submit"; submit.className = "secondary compact"; submit.textContent = "Trả lời";
    form.append(input, submit);
    form.addEventListener("submit", async (event) => {
      event.preventDefault(); const body = input.value.trim(); if (!body) return;
      submit.disabled = true; submit.textContent = "Đang gửi…";
      try { await onReply(thread, body); input.value = ""; }
      catch (error) { submit.disabled = false; submit.textContent = "Trả lời"; input.setCustomValidity(error.message || "Chưa gửi được trả lời."); input.reportValidity(); input.setCustomValidity(""); }
    });
    card.append(form);
  }
  if (allowStatus) {
    const action = document.createElement("button"); action.type = "button"; action.className = "link-button teacher-comment-status-action";
    action.textContent = thread.status === "addressed" ? "Mở lại trao đổi" : "Đánh dấu đã xử lý (không ẩn)";
    action.addEventListener("click", async () => {
      action.disabled = true;
      try { await onStatus(thread, thread.status === "addressed" ? "open" : "addressed"); }
      catch (error) { action.disabled = false; action.textContent = error.message || "Chưa đổi được trạng thái"; }
    });
    card.append(action);
  }
  return card;
}

export function renderStudentFieldComments(root, { fieldKey, text, threads, onReply }) {
  root.replaceChildren();
  const fieldThreads = threadsForField(threads, fieldKey, text);
  root.hidden = !fieldThreads.length;
  if (!fieldThreads.length) return;
  const title = document.createElement("h4"); title.textContent = `Comment trực tiếp của giảng viên · ${fieldThreads.length}`; root.append(title);
  const preview = document.createElement("div"); preview.className = "teacher-comment-preview"; preview.setAttribute("aria-label", "Bài viết có đánh dấu comment");
  const list = document.createElement("div"); list.className = "teacher-comment-thread-list";
  const focusThread = (threadRef) => list.querySelector(`[data-thread-ref="${CSS.escape(threadRef)}"]`)?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  renderAnnotatedText(preview, text, fieldThreads, focusThread); root.append(preview);
  for (const thread of fieldThreads) list.append(createTeacherCommentThreadCard(thread, { onReply }));
  root.append(list);
}
