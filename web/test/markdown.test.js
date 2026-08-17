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

test("keeps raw HTML as ordinary paragraph text", () => {
  const blocks = parseMarkdownBlocks("<script>alert('x')</script>");
  assert.deepEqual(blocks, [{ type: "paragraph", lines: ["<script>alert('x')</script>"] }]);
});
