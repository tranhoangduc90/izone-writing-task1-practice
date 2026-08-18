import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionRef = "22222222-2222-4222-8222-222222222222";
const attemptRef = "33333333-3333-4333-8333-333333333333";
let draftVersion = 0;
let draft = {
  overview: "Overall, Twitter was concentrated among younger users, while Facebook and YouTube had more balanced age profiles.",
  body1: "Compare Facebook and YouTube across the five age groups.",
  body2: "Describe Twitter's peak among users aged 18–34.",
  draft1: "Overall, Twitter was <phổ biến nhất> with younger users, while the other apps were balanced.",
  draft2: "Overall, Twitter was most popular among younger users, while Facebook and YouTube had more balanced age profiles.",
  draft2Unlocked: true
};
let attemptVersion = 1;
const provisionalRef = "66666666-6666-4666-8666-666666666666";
const teacherThreadRef = "77777777-7777-4777-8777-777777777777";
const teacherThreads = [{
  threadRef: teacherThreadRef,
  sectionKey: "overview",
  fieldKey: "overview",
  status: "open",
  anchor: { start: 0, end: 7, quote: "Overall", detached: false },
  createdAt: "2026-08-16T01:00:00.000Z",
  messages: [{ messageRef: "88888888-8888-4888-8888-888888888888", authorRole: "teacher", authorLabel: "Giảng viên", body: "Em hãy đối chiếu rõ hai nhóm ứng dụng trong câu này.", createdAt: "2026-08-16T01:00:00.000Z" }]
}];

function session() {
  return {
    sessionRef,
    draftVersion,
    ...draft,
    updatedAt: new Date().toISOString(),
    sections: {
      overview: { status: "passed", attemptsWithoutPass: 0 },
      outline: { status: "passed", attemptsWithoutPass: 0 },
      draft: { status: "passed", attemptsWithoutPass: 0 }
    },
    comments: [
      { commentRef: "55555555-5555-4555-8555-555555555551", section: "overview", commentNumber: 1, status: "completed", feedback: "## Điểm làm tốt\n\n- Bạn đã nêu được **đặc điểm nổi bật**.\n- Câu Overview có so sánh.", createdAt: "2026-08-13T08:00:00.000Z" },
      { commentRef: "55555555-5555-4555-8555-555555555552", section: "overview", commentNumber: 2, status: "completed", feedback: "## Kết quả\n\n**Đã đạt.** Bạn có thể chuyển sang Body Outline.", createdAt: "2026-08-13T08:05:00.000Z" },
      { commentRef: "55555555-5555-4555-8555-555555555553", section: "outline", commentNumber: 1, status: "completed", feedback: "1. **Chẩn đoán:** Hai đoạn đang trộn lẫn các hướng chia bài.\n\n**Phân tích:** Cách nhóm hiện tại làm mất logic so sánh.\n**Gợi mở:** Em hãy chọn một hướng chia nhất quán.\n**Next step:** Gom lại bảy nước.\n\n1. **Chẩn đoán:** Nhận xét sai mức tăng ở Body 2.\n\n**Phân tích:** Một số nước tăng hơn gấp đôi.\n**Gợi mở:** Em cần đối chiếu đúng mức tăng.\n**Next step:** Sửa lại từ khóa miêu tả mức tăng.\n\n1. **Chẩn đoán:** Thiếu số liệu quy mô ở Body 2.\n\n**Phân tích:** Nhận xét chưa có số chứng minh.\n**Gợi mở:** Em cần thêm số liệu xuất phát.\n**Next step:** Bổ sung số liệu.", createdAt: "2026-08-13T08:10:00.000Z" },
      { commentRef: "55555555-5555-4555-8555-555555555554", section: "outline", commentNumber: 2, status: "completed", feedback: "### Body 1\n\nCách nhóm đã rõ hơn.\n\n### Body 2\n\nHãy thêm sự đối chiếu với nhóm `18–34`.", createdAt: "2026-08-13T08:15:00.000Z" },
      { commentRef: "55555555-5555-4555-8555-555555555556", section: "draft", commentNumber: 1, status: "completed", feedback: "https://practice.izone.edu.vn/shared/writing-essays/demo-band6/edit?page=0", artifacts: { lmsUrl: "https://practice.izone.edu.vn/shared/writing-essays/demo-band6/edit?page=0" }, createdAt: "2026-08-15T08:30:00.000Z" }
    ],
    attempts: []
  };
}

function json(response, status, value, headers = {}) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", ...headers });
  response.end(JSON.stringify(value));
}

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, "http://127.0.0.1:8080");
  if (/^\/api\/v1\/activities\/(sample-task|pie-app-users-by-age)\/roster$/u.test(url.pathname)) {
    return json(response, 200, { ok: true, classes: [{ classRef: "11111111-1111-4111-8111-111111111111", className: "Lớp thử giao diện", students: [{ studentRef: "44444444-4444-4444-8444-444444444444", alias: "Nguyễn Minh Anh" }] }] });
  }
  if (/^\/api\/v1\/activities\/(sample-task|pie-app-users-by-age)\/provisional-students$/u.test(url.pathname) && request.method === "POST") {
    const value = await body(request);
    if (!/^\d{4}$/u.test(value.pin || "")) return json(response, 400, { ok: false, error: "INVALID_REQUEST", message: "Mã phải có bốn số." });
    return json(response, 201, { ok: true, student: { studentRef: provisionalRef, displayName: value.displayName, alias: value.displayName, provisional: true, requiresAccessCode: true } });
  }
  if (url.pathname === "/config.json") return json(response, 200, { apiBase: "http://127.0.0.1:8080/", googleClientId: "mock-client-id" });
  if (url.pathname === "/api/v1/admin/live/activities/pie-app-users-by-age") {
    const base = { classRef: "11111111-1111-4111-8111-111111111111", className: "Lớp thử giao diện", online: false, totalFields: 5, passedSectionCount: 0, attemptedSectionCount: 1, checkCount: 1, sections: { overview: { status: "revision" } }, responses: {} };
    return json(response, 200, { ok: true, generatedAt: new Date().toISOString(), students: [
      { ...base, studentRef: "70000000-0000-4000-8000-000000000009", sessionRef, displayName: "Học viên mốc 9", hasStarted: true, filledFields: 3, progressPercent: 60, supportRequired: true, supportSections: [{ section: "overview", commentNumber: 9, warningAt: "2026-08-15T01:00:00Z" }] },
      { ...base, studentRef: "70000000-0000-4000-8000-000000000003", displayName: "Học viên tạm mốc 3", provisional: true, reconciliationStatus: "pending", hasStarted: true, filledFields: 1, progressPercent: 20, supportRequired: true, supportSections: [{ section: "outline", commentNumber: 3, warningAt: "2026-08-15T00:00:00Z" }] },
      { ...base, studentRef: "70000000-0000-4000-8000-000000000010", displayName: "Tiến trình thấp", hasStarted: true, filledFields: 1, progressPercent: 20, supportRequired: false },
      { ...base, studentRef: "70000000-0000-4000-8000-000000000080", displayName: "Tiến trình cao", hasStarted: true, filledFields: 4, progressPercent: 80, passedSectionCount: 2, supportRequired: false },
      { ...base, studentRef: "70000000-0000-4000-8000-000000000000", displayName: "Chưa bắt đầu", hasStarted: false, filledFields: 0, progressPercent: 0, attemptedSectionCount: 0, checkCount: 0, sections: {}, supportRequired: false }
    ] });
  }
  if (url.pathname === `/api/v1/admin/live/sessions/${sessionRef}` && request.method === "GET") {
    return json(response, 200, { ok: true, session: session() });
  }
  if (url.pathname === `/api/v1/admin/live/sessions/${sessionRef}/teacher-comments` && request.method === "GET") {
    return json(response, 200, { ok: true, threads: teacherThreads }, { etag: `"teacher-comments-${teacherThreads[0].messages.length}"` });
  }
  if (url.pathname === "/api/v1/admin/activities/pie-app-users-by-age/provisional-students") return json(response, 200, { ok: true, students: [{ studentRef: "70000000-0000-4000-8000-000000000003", displayName: "Học viên tạm mốc 3", classRef: "11111111-1111-4111-8111-111111111111", className: "Lớp thử giao diện", reconciliationStatus: "pending" }] });
  if (url.pathname === "/api/v1/sessions" && request.method === "POST") return json(response, 201, { ok: true, session: session() });
  if (url.pathname === `/api/v1/sessions/${sessionRef}` && request.method === "GET") return json(response, 200, { ok: true, session: session() });
  if (url.pathname === `/api/v1/sessions/${sessionRef}/draft-result` && request.method === "GET") {
    const fixture = JSON.parse(await fs.readFile(path.join(root, "demo-lms-draft-result.json"), "utf8"));
    return json(response, 200, { ok: true, result: { ...fixture.lmsResponse, updatedAt: "2026-08-18T01:00:00.000Z" } });
  }
  if (url.pathname === `/api/v1/sessions/${sessionRef}/live` && request.method === "PUT") return json(response, 200, { ok: true, accepted: true });
  if (url.pathname === `/api/v1/sessions/${sessionRef}/teacher-comments` && request.method === "GET") return json(response, 200, { ok: true, threads: teacherThreads }, { etag: `"teacher-comments-${teacherThreads[0].messages.length}"` });
  if (url.pathname === `/api/v1/sessions/${sessionRef}/teacher-comments/${teacherThreadRef}/replies` && request.method === "POST") {
    const value = await body(request); teacherThreads[0].messages.push({ messageRef: crypto.randomUUID(), authorRole: "student", authorLabel: "Học viên", body: value.body, createdAt: new Date().toISOString() });
    return json(response, 201, { ok: true, thread: teacherThreads[0] });
  }
  if (url.pathname === `/api/v1/sessions/${sessionRef}/draft` && request.method === "PUT") {
    const value = await body(request); draft = { overview: value.overview, body1: value.body1, body2: value.body2, draft1: value.draft1, draft2: value.draft2, draft2Unlocked: value.draft2Unlocked }; draftVersion += 1;
    return json(response, 200, { ok: true, session: session() });
  }
  if (url.pathname === `/api/v1/sessions/${sessionRef}/checks` && request.method === "POST") {
    return json(response, 202, { ok: true, attempt: { attemptRef, commentRef: "55555555-5555-4555-8555-555555555555", section: "overview", commentNumber: 1, status: "queued", version: 1 } });
  }
  if (url.pathname === `/api/v1/attempts/${attemptRef}` && request.method === "GET") {
    attemptVersion += 1;
    return json(response, 200, { ok: true, attempt: { attemptRef, section: "overview", commentNumber: 1, status: "completed", resultStatus: "needs_revision", attemptsWithoutPass: 1, version: attemptVersion, comment: { commentRef: "55555555-5555-4555-8555-555555555555", attemptRef, section: "overview", commentNumber: 1, status: "completed", feedback: "Bạn đã nêu được xu hướng chính. Hãy đối chiếu thêm nhóm cao nhất và thấp nhất.", createdAt: new Date().toISOString() } } }, { etag: `"attempt-${attemptVersion}"` });
  }

  const relative = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const target = path.resolve(root, relative);
  if (!target.startsWith(root + path.sep)) return json(response, 403, { ok: false });
  try {
    const content = await fs.readFile(target);
    const type = target.endsWith(".html") ? "text/html" : target.endsWith(".js") || target.endsWith(".mjs") ? "text/javascript" : target.endsWith(".css") ? "text/css" : "application/json";
    response.writeHead(200, { "content-type": `${type}; charset=utf-8` }); response.end(content);
  } catch { json(response, 404, { ok: false }); }
});

server.listen(8080, "127.0.0.1", () => process.stdout.write("Mock Writing Task 1 chạy tại http://127.0.0.1:8080\n"));
