import test from "node:test";
import assert from "node:assert/strict";
import { parseMarkdownBlocks } from "../js/markdown.js";

test("parses the feedback format used by the former Google Docs renderer", () => {
  const blocks = parseMarkdownBlocks("## Điểm tốt\n\n- **Overview** rõ ràng\n- Có so sánh\n\n1. Sửa số liệu\n2. Kiểm tra lại");
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "list", "list"]);
  assert.equal(blocks[1].ordered, false);
  assert.equal(blocks[2].ordered, true);
});

test("keeps ordered feedback items separated by blank lines in one list", () => {
  const blocks = parseMarkdownBlocks("1. Chẩn đoán\n\n1. Phân tích đối chiếu\n\n1. Next step\n\nKết luận");
  assert.deepEqual(blocks.map((block) => block.type), ["list", "paragraph"]);
  assert.equal(blocks[0].ordered, true);
  assert.deepEqual(blocks[0].items.map((item) => item.text), ["Chẩn đoán", "Phân tích đối chiếu", "Next step"]);
});

test("continues numbering when each diagnosis has explanatory paragraphs", () => {
  const feedback = [
    "1. **Chẩn đoán:** Hai đoạn đang trộn lẫn các hướng chia bài.",
    "",
    "**Phân tích:** Cách nhóm hiện tại làm mất logic so sánh.",
    "**Gợi mở:** Em hãy chọn một hướng chia nhất quán.",
    "**Next step:** Gom lại bảy nước.",
    "",
    "1. **Chẩn đoán:** Nhận xét sai mức tăng ở Body 2.",
    "",
    "**Phân tích:** Một số nước tăng hơn gấp đôi.",
    "**Next step:** Sửa lại từ khóa miêu tả mức tăng.",
    "",
    "1. **Chẩn đoán:** Thiếu số liệu quy mô ở Body 2.",
    "",
    "**Next step:** Bổ sung số liệu.",
  ].join("\n");
  const lists = parseMarkdownBlocks(feedback).filter((block) => block.type === "list");
  assert.equal(lists.length, 3);
  assert.deepEqual(lists.map((block) => block.start), [1, 2, 3]);
  assert.deepEqual(lists.map((block) => block.items[0].text.split(":", 1)[0]), [
    "**Chẩn đoán", "**Chẩn đoán", "**Chẩn đoán",
  ]);
});

test("resets numbering after a new heading", () => {
  const blocks = parseMarkdownBlocks("1. Mục đầu\n\nChi tiết\n\n1. Mục tiếp\n\n## Phần mới\n\n1. Mục mới");
  assert.deepEqual(blocks.filter((block) => block.type === "list").map((block) => block.start), [1, 2, 1]);
});

test("keeps raw HTML as ordinary paragraph text", () => {
  const blocks = parseMarkdownBlocks("<script>alert('x')</script>");
  assert.deepEqual(blocks, [{ type: "paragraph", lines: ["<script>alert('x')</script>"] }]);
});
