import { appendMarkdown } from "./markdown.js?v=20260818-numbering-v3";

const MAX_ESSAYS = 80;
const MAX_COMMENT_LENGTH = 20_000;
const ALLOWED_COMMENT_TAGS = new Set(["p", "br", "strong", "b", "em", "i", "ul", "ol", "li", "code", "blockquote"]);
const DROP_WITH_CONTENT = new Set(["script", "style", "iframe", "object", "embed", "template", "svg", "math"]);

function clippedText(value, limit = MAX_COMMENT_LENGTH) {
  return typeof value === "string" ? value.slice(0, limit) : "";
}

function safeIndex(value, fallback) {
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function proseMirrorBlocks(documentValue = {}) {
  const blocks = [];

  const inlineRuns = (node) => {
    const runs = [];
    const visit = (current) => {
      if (!current || typeof current !== "object") return;
      if (current.type === "text" && typeof current.text === "string") {
        runs.push({
          text: current.text,
          highlighted: Array.isArray(current.marks) && current.marks.some((mark) => mark?.type === "highlight"),
        });
        return;
      }
      if (current.type === "hardBreak") {
        runs.push({ text: "\n", highlighted: false });
        return;
      }
      for (const child of Array.isArray(current.content) ? current.content : []) visit(child);
    };
    visit(node);
    return runs;
  };

  const visitBlock = (node) => {
    if (!node || typeof node !== "object") return;
    if (["paragraph", "heading"].includes(node.type)) {
      blocks.push({ type: "paragraph", runs: inlineRuns(node) });
      return;
    }
    if (["bulletList", "orderedList"].includes(node.type)) {
      const items = (Array.isArray(node.content) ? node.content : []).map((item) => inlineRuns(item));
      blocks.push({ type: node.type === "orderedList" ? "ordered-list" : "bullet-list", items });
      return;
    }
    for (const child of Array.isArray(node.content) ? node.content : []) visitBlock(child);
  };

  visitBlock(documentValue);
  return blocks;
}

export function normalizeLmsDraftPayload(payload = {}) {
  const essays = Array.isArray(payload?.essays) ? payload.essays : [];
  return {
    essays: essays.slice(0, MAX_ESSAYS).filter((essay) => essay && typeof essay === "object").map((essay, position) => ({
      id: clippedText(essay.id, 120) || `sentence-${position + 1}`,
      index: safeIndex(essay.index, position),
      originalBlocks: proseMirrorBlocks(essay.content),
      suggestedBlocks: proseMirrorBlocks(essay.suggestedContent),
      comments: (Array.isArray(essay.comments) ? essay.comments : []).map((comment) => clippedText(comment)).filter(Boolean),
    })).sort((left, right) => left.index - right.index),
  };
}

function appendRuns(root, runs, kind) {
  for (const run of runs) {
    if (!run.text) continue;
    if (!run.highlighted) {
      root.append(root.ownerDocument.createTextNode(run.text));
      continue;
    }
    const mark = root.ownerDocument.createElement("mark");
    mark.className = "lms-change-highlight";
    mark.dataset.kind = kind;
    mark.textContent = run.text;
    root.append(mark);
  }
}

function renderBlocks(root, blocks, kind) {
  if (!blocks.length) {
    const empty = root.ownerDocument.createElement("p");
    empty.className = "muted";
    empty.textContent = "Không có nội dung.";
    root.append(empty);
    return;
  }
  for (const block of blocks) {
    if (block.type === "paragraph") {
      const paragraph = root.ownerDocument.createElement("p");
      appendRuns(paragraph, block.runs, kind);
      root.append(paragraph);
      continue;
    }
    const list = root.ownerDocument.createElement(block.type === "ordered-list" ? "ol" : "ul");
    for (const runs of block.items) {
      const item = root.ownerDocument.createElement("li");
      appendRuns(item, runs, kind);
      list.append(item);
    }
    root.append(list);
  }
}

function appendSanitizedComment(root, html) {
  const documentRef = root.ownerDocument;
  const template = documentRef.createElement("template");
  template.innerHTML = html;

  const copy = (node) => {
    if (node.nodeType === 3) return documentRef.createTextNode(node.textContent || "");
    if (node.nodeType !== 1) return documentRef.createDocumentFragment();
    const tag = node.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) return documentRef.createDocumentFragment();
    const output = ALLOWED_COMMENT_TAGS.has(tag)
      ? documentRef.createElement(tag === "b" ? "strong" : tag === "i" ? "em" : tag)
      : documentRef.createDocumentFragment();
    for (const child of node.childNodes) output.append(copy(child));
    return output;
  };

  for (const child of template.content.childNodes) root.append(copy(child));
}

function appendSafeComment(root, value) {
  const comment = clippedText(value);
  if (/<\/?[a-z][\s\S]*>/iu.test(comment)) {
    appendSanitizedComment(root, comment);
    return;
  }
  // AI đôi khi trả các mục "1." có dòng trống ở giữa. Bộ render Markdown giữ
  // chúng trong cùng một danh sách để trình duyệt hiển thị liên tục 1, 2, 3.
  appendMarkdown(root, comment);
}

export function draftPagerState(requestedIndex, total) {
  const safeTotal = Number.isInteger(total) && total > 0 ? total : 0;
  if (!safeTotal) return { index: 0, position: 0, total: 0, atStart: true, atEnd: true };
  const numericIndex = Number.isFinite(requestedIndex) ? Math.trunc(requestedIndex) : 0;
  const index = Math.min(Math.max(numericIndex, 0), safeTotal - 1);
  return { index, position: index + 1, total: safeTotal, atStart: index === 0, atEnd: index === safeTotal - 1 };
}

function versionCard(documentRef, title, kind, blocks) {
  const section = documentRef.createElement("section");
  section.className = "lms-version";
  section.dataset.kind = kind;
  const label = documentRef.createElement("h5");
  label.className = "lms-version-label";
  label.textContent = title;
  const content = documentRef.createElement("div");
  content.className = "lms-prosemirror";
  renderBlocks(content, blocks, kind);
  section.append(label, content);
  return section;
}

export function renderLmsDraftResult(root, payload, {
  updatedAt = null,
  initialIndex = 0,
  onPageChange = null,
} = {}) {
  const { essays } = normalizeLmsDraftPayload(payload);
  const documentRef = root.ownerDocument;
  root.replaceChildren();

  if (!essays.length) {
    const empty = documentRef.createElement("p");
    empty.className = "draft-result-message";
    empty.textContent = "Chưa có thẻ nhận xét từng câu.";
    root.append(empty);
    return { count: 0 };
  }

  const summary = documentRef.createElement("div");
  summary.className = "lms-draft-summary";
  const summaryText = documentRef.createElement("div");
  const heading = documentRef.createElement("h4");
  heading.textContent = `${essays.length} thẻ cần xem`;
  summaryText.append(heading);
  if (updatedAt) {
    const time = documentRef.createElement("time");
    time.dateTime = updatedAt;
    time.textContent = `Cập nhật ${new Date(updatedAt).toLocaleString("vi-VN")}`;
    summary.append(summaryText, time);
  } else {
    summary.append(summaryText);
  }
  root.append(summary);

  const cards = documentRef.createElement("div");
  cards.className = "lms-sentence-cards";
  const cardElements = [];
  essays.forEach((essay, position) => {
    const card = documentRef.createElement("article");
    card.className = "lms-sentence-card";
    card.dataset.sentenceIndex = String(essay.index);
    const cardHeader = documentRef.createElement("header");
    cardHeader.className = "lms-sentence-header";
    const title = documentRef.createElement("h4");
    title.tabIndex = -1;
    title.textContent = `Thẻ ${position + 1}`;
    const counter = documentRef.createElement("span");
    counter.textContent = `${position + 1}/${essays.length}`;
    cardHeader.append(title, counter);

    const comparison = documentRef.createElement("div");
    comparison.className = "lms-comparison";
    comparison.append(
      versionCard(documentRef, "Bài của em", "original", essay.originalBlocks),
      versionCard(documentRef, "Gợi ý chỉnh sửa", "suggested", essay.suggestedBlocks),
    );
    card.append(cardHeader, comparison);

    if (essay.comments.length) {
      const review = documentRef.createElement("section");
      review.className = "lms-sentence-review";
      const reviewTitle = documentRef.createElement("h5");
      reviewTitle.textContent = "Nhận xét";
      const reviewBody = documentRef.createElement("div");
      reviewBody.className = "lms-sentence-review-body";
      for (const comment of essay.comments) {
        const commentBlock = documentRef.createElement("div");
        appendSafeComment(commentBlock, comment);
        reviewBody.append(commentBlock);
      }
      review.append(reviewTitle, reviewBody);
      card.append(review);
    }
    card.hidden = position !== 0;
    card.setAttribute("aria-hidden", position === 0 ? "false" : "true");
    cardElements.push(card);
    cards.append(card);
  });

  const pager = documentRef.createElement("nav");
  pager.className = "lms-draft-pager";
  pager.setAttribute("aria-label", "Chuyển giữa các thẻ chấm từng câu");
  const previous = documentRef.createElement("button");
  previous.type = "button";
  previous.className = "secondary lms-page-button";
  previous.textContent = "← Trang trước";
  const pageStatus = documentRef.createElement("strong");
  pageStatus.className = "lms-page-status";
  pageStatus.setAttribute("aria-live", "polite");
  const next = documentRef.createElement("button");
  next.type = "button";
  next.className = "primary lms-page-button";
  next.textContent = "Trang tiếp theo →";
  pager.append(previous, pageStatus, next);

  let currentIndex = 0;
  const showPage = (requestedIndex, { moveFocus = false } = {}) => {
    const state = draftPagerState(requestedIndex, cardElements.length);
    currentIndex = state.index;
    cardElements.forEach((card, index) => {
      const active = index === currentIndex;
      card.hidden = !active;
      card.setAttribute("aria-hidden", active ? "false" : "true");
    });
    previous.disabled = state.atStart;
    next.disabled = state.atEnd;
    pageStatus.textContent = `Thẻ ${state.position} / ${state.total}`;
    if (moveFocus) {
      const activeCard = cardElements[currentIndex];
      activeCard.querySelector("h4")?.focus({ preventScroll: true });
    }
    if (typeof onPageChange === "function") onPageChange(currentIndex);
    return state;
  };

  previous.addEventListener("click", () => showPage(currentIndex - 1, { moveFocus: true }));
  next.addEventListener("click", () => showPage(currentIndex + 1, { moveFocus: true }));
  root.append(cards, pager);
  showPage(initialIndex);
  return { count: essays.length, showPage };
}
