// Dữ liệu nhận vào: giao diện Task 1 cục bộ và API giả có độ trễ cố ý.
// Việc chính: bấm Check ba lần liên tiếp rồi kiểm tra nút khóa và số request thực tế.
// Kết quả: chỉ một lượt lưu và một lượt Check được gửi; ảnh nằm trong output/playwright.
// Khi lỗi: script trả exit code khác 0, không gọi production và không dùng dữ liệu học viên thật.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(webRoot, '..', 'output', 'playwright');
const sessionRef = '11111111-1111-4111-8111-111111111111';
const classRef = '22222222-2222-4222-8222-222222222222';
const studentRef = '33333333-3333-4333-8333-333333333333';
let revision = 0;
let overview = 'Overall, the three applications attracted different age groups.';
let saveRequests = 0;
let checkRequests = 0;

function json(response, value, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function session() {
  return {
    sessionRef,
    draftVersion: revision,
    overview,
    body1: '',
    body2: '',
    draft1: '',
    draft2: '',
    draft2Unlocked: false,
    sections: {
      overview: { status: 'draft', attemptsWithoutPass: 0 },
      outline: { status: 'draft', attemptsWithoutPass: 0 },
      draft: { status: 'draft', attemptsWithoutPass: 0 }
    },
    comments: [],
    attempts: [],
    updatedAt: new Date().toISOString()
  };
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://local.test');
  const apiBase = `http://127.0.0.1:${server.address().port}/`;
  if (url.pathname === '/config.json') return json(response, { apiBase, googleClientId: 'visual-test-client' });
  if (url.pathname === '/api/v1/activities/sample-task/roster') {
    return json(response, { ok: true, classes: [{ classRef, className: 'Lớp kiểm thử', students: [{ studentRef, alias: 'Học viên kiểm thử' }] }] });
  }
  if (url.pathname === '/api/v1/sessions' && request.method === 'POST') return json(response, { ok: true, session: session() }, 201);
  if (url.pathname === `/api/v1/sessions/${sessionRef}` && request.method === 'GET') return json(response, { ok: true, session: session() });
  if (url.pathname === `/api/v1/sessions/${sessionRef}/draft` && request.method === 'PUT') {
    saveRequests += 1;
    const body = await readBody(request);
    await new Promise(resolve => setTimeout(resolve, 450));
    overview = body.overview;
    revision += 1;
    return json(response, { ok: true, session: session() });
  }
  if (url.pathname === `/api/v1/sessions/${sessionRef}/checks` && request.method === 'POST') {
    checkRequests += 1;
    await new Promise(resolve => setTimeout(resolve, 450));
    return json(response, { ok: true, attempt: { attemptRef: '44444444-4444-4444-8444-444444444444', section: 'overview', status: 'queued', commentNumber: 1 } }, 202);
  }
  if (url.pathname === `/api/v1/sessions/${sessionRef}/live`) return json(response, { ok: true, accepted: true });
  if (url.pathname === `/api/v1/sessions/${sessionRef}/teacher-comments`) return json(response, { ok: true, threads: [] });

  const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
  const file = path.resolve(webRoot, relative);
  if (!file.startsWith(webRoot)) { response.writeHead(403); return response.end(); }
  try {
    const content = await fs.readFile(file);
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/json';
    response.writeHead(200, { 'content-type': `${type}; charset=utf-8` });
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end();
  }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' });
await fs.mkdir(outputRoot, { recursive: true });

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(`http://127.0.0.1:${port}/index.html?task=sample-task`);
  await page.selectOption('#class-id', classRef);
  await page.selectOption('#student-name', studentRef);
  await page.click('#identity-form button[type="submit"]');
  await page.waitForSelector('#workspace:not([hidden])');
  await page.locator('textarea[name="overview"]').fill(`${overview} The contrast is clear.`);

  const firstButton = page.locator('[data-section="overview"] .submit-section');
  await firstButton.evaluate(button => { button.click(); button.click(); button.click(); });
  await page.waitForFunction(() => document.querySelector('[data-section="overview"] .submit-section')?.textContent === 'Đang gửi bài…');
  assert.equal(await page.locator('[data-section="overview"] .submit-section').isDisabled(), true);
  await page.waitForFunction(() => document.querySelector('[data-section="overview"] .submit-section')?.textContent === 'Đang chấm — không cần bấm lại');
  assert.equal(saveRequests, 1);
  assert.equal(checkRequests, 1);
  await page.screenshot({ path: path.join(outputRoot, 'task1-check-waiting.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await page.screenshot({ path: path.join(outputRoot, 'task1-check-waiting-mobile.png'), fullPage: true });
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log(JSON.stringify({ ok: true, saveRequests, checkRequests }));
