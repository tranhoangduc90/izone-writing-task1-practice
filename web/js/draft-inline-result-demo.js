import { renderLmsDraftResult } from "./lms-draft-result.js?v=20260818-numbering-v3";

const response = await fetch("./demo-lms-draft-result.json", { cache: "no-store" });
if (!response.ok) throw new Error("Không tải được dữ liệu demo kết quả Draft.");
const payload = await response.json();

document.querySelector("#demo-draft1").value = payload.draft1;
document.querySelector("#demo-draft2").value = payload.draft2;
const result = renderLmsDraftResult(document.querySelector("#demo-inline-result"), payload.lmsResponse, {
  updatedAt: payload.updatedAt,
});
document.querySelector("#demo-result-count").textContent = `${result.count} thẻ`;
