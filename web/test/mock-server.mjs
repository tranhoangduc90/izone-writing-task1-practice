import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sessionRef = "22222222-2222-4222-8222-222222222222";
const attemptRef = "33333333-3333-4333-8333-333333333333";
let draftVersion = 0;
let draft = { overview: "", body1: "", body2: "" };
let attemptVersion = 1;

function session() {
  return {
    sessionRef,
    draftVersion,
    ...draft,
    updatedAt: new Date().toISOString(),
    sections: {
      overview: { status: "draft", attemptsWithoutPass: 0 },
      outline: { status: "draft", attemptsWithoutPass: 0 }
    },
    comments: [],
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
  if (url.pathname === "/api/v1/activities/sample-task/roster") {
    return json(response, 200, { ok: true, classes: [{ classRef: "11111111-1111-4111-8111-111111111111", className: "Lớp thử giao diện", students: [{ studentRef: "44444444-4444-4444-8444-444444444444", alias: "Nguyễn Minh Anh" }] }] });
  }
  if (url.pathname === "/api/v1/sessions" && request.method === "POST") return json(response, 201, { ok: true, session: session() });
  if (url.pathname === `/api/v1/sessions/${sessionRef}` && request.method === "GET") return json(response, 200, { ok: true, session: session() });
  if (url.pathname === `/api/v1/sessions/${sessionRef}/draft` && request.method === "PUT") {
    const value = await body(request); draft = { overview: value.overview, body1: value.body1, body2: value.body2 }; draftVersion += 1;
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
