// Chuyển Markdown đơn giản thành cấu trúc an toàn để trình duyệt hiển thị.
// Không dùng innerHTML nên nội dung từ hệ thống chấm không thể chạy mã HTML/JavaScript.
export function parseMarkdownBlocks(value) {
  const lines = String(value || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];
  let list = null;
  let orderedSequenceEnd = 0;

  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: "paragraph", lines: paragraph });
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    blocks.push(list);
    list = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.replace(/\s+$/u, "");
    if (!line.trim()) {
      flushParagraph();
      // Giữ danh sách mở để các mục có dòng trống ở giữa vẫn được đánh số liên tục.
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,4})\s+(.+)$/u);
    if (heading) {
      flushParagraph(); flushList();
      orderedSequenceEnd = 0;
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    if (/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/u.test(line)) {
      flushParagraph(); flushList(); orderedSequenceEnd = 0; blocks.push({ type: "rule" }); continue;
    }
    const listItem = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/u);
    if (listItem) {
      flushParagraph();
      const ordered = /^\d/u.test(listItem[2]);
      if (!list || list.ordered !== ordered) {
        flushList();
        if (ordered) {
          const requestedStart = Number.parseInt(listItem[2], 10);
          const start = Math.max(requestedStart, orderedSequenceEnd + 1);
          list = { type: "list", ordered, start, items: [] };
        } else {
          orderedSequenceEnd = 0;
          list = { type: "list", ordered, items: [] };
        }
      }
      list.items.push({ text: listItem[3], depth: Math.min(3, Math.floor(listItem[1].length / 2)) });
      if (ordered) orderedSequenceEnd = list.start + list.items.length - 1;
      continue;
    }
    const quote = line.match(/^\s{0,3}>\s?(.*)$/u);
    if (quote) {
      flushParagraph(); flushList(); orderedSequenceEnd = 0; blocks.push({ type: "quote", text: quote[1] }); continue;
    }
    flushList(); paragraph.push(line.trim());
  }
  flushParagraph(); flushList();
  return blocks;
}

function safeLink(value) {
  try {
    const url = new URL(value, window.location.href);
    return ["http:", "https:"].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

export function appendInlineMarkdown(root, value) {
  const source = String(value || "");
  const tokenPattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^\s)]+\)|\*[^*\n]+\*)/gu;
  let cursor = 0;
  for (const match of source.matchAll(tokenPattern)) {
    if (match.index > cursor) root.append(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("**")) {
      const strong = document.createElement("strong"); strong.textContent = token.slice(2, -2); root.append(strong);
    } else if (token.startsWith("`")) {
      const code = document.createElement("code"); code.textContent = token.slice(1, -1); root.append(code);
    } else if (token.startsWith("[")) {
      const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/u); const href = parts && safeLink(parts[2]);
      if (href) { const link = document.createElement("a"); link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer"; link.textContent = parts[1]; root.append(link); }
      else root.append(document.createTextNode(token));
    } else {
      const emphasis = document.createElement("em"); emphasis.textContent = token.slice(1, -1); root.append(emphasis);
    }
    cursor = match.index + token.length;
  }
  if (cursor < source.length) root.append(document.createTextNode(source.slice(cursor)));
}

export function appendMarkdown(root, value) {
  for (const block of parseMarkdownBlocks(value)) {
    if (block.type === "rule") { root.append(document.createElement("hr")); continue; }
    if (block.type === "list") {
      const list = document.createElement(block.ordered ? "ol" : "ul");
      if (block.ordered && block.start > 1) list.start = block.start;
      for (const item of block.items) {
        const li = document.createElement("li"); li.dataset.depth = String(item.depth); appendInlineMarkdown(li, item.text); list.append(li);
      }
      root.append(list); continue;
    }
    const element = document.createElement(block.type === "heading" ? `h${Math.min(4, block.level + 2)}` : block.type === "quote" ? "blockquote" : "p");
    const lines = block.lines || [block.text];
    lines.forEach((line, index) => { if (index) element.append(document.createElement("br")); appendInlineMarkdown(element, line); });
    root.append(element);
  }
}
