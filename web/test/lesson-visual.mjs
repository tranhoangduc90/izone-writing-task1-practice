// Dữ liệu nhận vào: các file web cục bộ và API giả chỉ dùng trong phép kiểm tra.
// Việc chính: mở handout ở desktop/mobile, thao tác chọn học viên và kiểm bố cục dashboard.
// Kết quả: tạo ảnh PNG trong output/playwright và dừng nếu thiếu section hoặc trang bị tràn ngang.
// Khi lỗi: script trả exit code khác 0; không gọi API production và không chứa dữ liệu học viên thật.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(webRoot, '..', 'output', 'playwright');
const uuid = '11111111-1111-4111-8111-111111111111';
const studentRef = '22222222-2222-4222-8222-222222222222';
const classRef = '33333333-3333-4333-8333-333333333333';
const responses = {
  body1_idea1: 'Young leaders are often more adaptable.',
  body1_idea2: 'They understand technology.',
  body1_topic: 'Young leaders can help organisations adapt.'
};
let revision = 0;
let teacherThreads = [{
  threadRef: '44444444-4444-4444-8444-444444444444', sectionKey: 'body1_support1', fieldKey: 'body1_idea1', status: 'open',
  anchor: { start: 0, end: 13, quote: 'Young leaders', detached: false }, createdAt: '2026-08-16T01:00:00Z',
  messages: [{ messageRef: '55555555-5555-4555-8555-555555555555', authorRole: 'teacher', authorLabel: 'Giảng viên', body: 'Em hãy làm rõ đặc điểm thích nghi ở đây.', createdAt: '2026-08-16T01:00:00Z' }]
}];

function json(response, value, status = 200, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(value));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, 'http://local.test');
  if (url.pathname === '/config.json') return json(response, { apiBase: `http://127.0.0.1:${server.address().port}/mock/`, googleClientId: 'visual-test-client' });
  if (url.pathname === '/mock/api/v1/activities/writing-lesson13-young-leaders/roster') return json(response, { ok: true, classes: [{ classRef, className: 'Lớp 67', students: [{ studentRef, alias: 'Học viên kiểm thử' }] }] });
  if (url.pathname === '/mock/api/v1/lesson-sessions' && request.method === 'POST') return json(response, { ok: true, session: { sessionRef: uuid } }, 201);
  if (url.pathname === `/mock/api/v1/lesson-sessions/${uuid}`) return json(response, { ok: true, session: { sessionRef: uuid, draftVersion: revision, responses, sections: {}, comments: [], attempts: [], updatedAt: new Date().toISOString() } });
  if (url.pathname === `/mock/api/v1/lesson-sessions/${uuid}/responses` && request.method === 'PUT') {
    const body = await readBody(request); Object.assign(responses, body.responses); revision += 1;
    return json(response, { ok: true, session: { sessionRef: uuid, draftVersion: revision, responses, sections: {}, comments: [], attempts: [], updatedAt: new Date().toISOString() } });
  }
  if (url.pathname === `/mock/api/v1/lesson-sessions/${uuid}/live`) return json(response, { ok: true, accepted: true });
  if (url.pathname === `/mock/api/v1/sessions/${uuid}/teacher-comments` && request.method === 'GET') return json(response, { ok: true, threads: teacherThreads }, 200, { etag: `"teacher-comments-${teacherThreads.length}"` });
  if (url.pathname.match(new RegExp(`^/mock/api/v1/sessions/${uuid}/teacher-comments/[^/]+/replies$`)) && request.method === 'POST') {
    const payload = await readBody(request); const thread = teacherThreads.find(item => url.pathname.includes(item.threadRef));
    thread.messages.push({ messageRef: crypto.randomUUID(), authorRole: 'student', authorLabel: 'Học viên', body: payload.body, createdAt: new Date().toISOString() });
    return json(response, { ok: true, thread }, 201);
  }
  if (url.pathname === '/mock/api/v1/admin/live/activities/writing-lesson13-young-leaders') return json(response, { ok: true, generatedAt: new Date().toISOString(), permissions: { canManage: false }, students: [{ sessionRef: uuid, classRef, className: 'Lớp 67', studentRef, displayName: 'Học viên kiểm thử', online: true, savedAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), activeField: 'body1_topic', responses: { body1_idea1: 'Young leaders are often more adaptable.' }, sections: { body1_topic: { status: 'revision', attemptsWithoutPass: 3 } }, checkCount: 3, supportWarning: true }] });
  if (url.pathname === '/mock/api/v1/admin/activities/writing-lesson13-young-leaders/provisional-students') return json(response, { ok: true, students: [] });
  if (url.pathname === `/mock/api/v1/admin/live/sessions/${uuid}`) return json(response, { ok: true, session: {
    sessionRef: uuid,
    draftVersion: revision,
    responses,
    sections: { body1_topic: { status: 'revision', attemptsWithoutPass: 3 } },
    comments: [
      { section: 'body1_topic', commentNumber: 1, status: 'completed', feedback: '### Cần sửa\n- Làm rõ hai supporting ideas.', createdAt: '2026-08-14T01:00:00Z', artifacts: {} },
      { section: 'body1_topic', commentNumber: 2, status: 'completed', feedback: '### Tiến bộ\n**Topic Sentence** đã rõ hơn.', createdAt: '2026-08-14T02:00:00Z', artifacts: { vocabulary: { body1: [{ idea: 'thích nghi nhanh', terms: 'adapt quickly' }] } } }
    ]
  } });
  if (url.pathname === `/mock/api/v1/admin/live/sessions/${uuid}/teacher-comments` && request.method === 'GET') return json(response, { ok: true, threads: teacherThreads }, 200, { etag: `"teacher-comments-${teacherThreads.length}"` });
  if (url.pathname === `/mock/api/v1/admin/live/sessions/${uuid}/teacher-comments` && request.method === 'POST') {
    const payload = await readBody(request); const text = responses[payload.fieldKey] || '';
    const thread = { threadRef: crypto.randomUUID(), sectionKey: payload.sectionKey, fieldKey: payload.fieldKey, status: 'open',
      anchor: { start: payload.start, end: payload.end, quote: text.slice(payload.start, payload.end), detached: false }, createdAt: new Date().toISOString(),
      messages: [{ messageRef: crypto.randomUUID(), authorRole: 'teacher', authorLabel: 'Giảng viên', body: payload.body, createdAt: new Date().toISOString() }] };
    teacherThreads.push(thread); return json(response, { ok: true, thread }, 201);
  }
  if (url.pathname.match(/^\/mock\/api\/v1\/admin\/teacher-comments\/[^/]+\/replies$/u) && request.method === 'POST') {
    const payload = await readBody(request); const thread = teacherThreads.find(item => url.pathname.includes(item.threadRef));
    thread.messages.push({ messageRef: crypto.randomUUID(), authorRole: 'teacher', authorLabel: 'Giảng viên', body: payload.body, createdAt: new Date().toISOString() });
    return json(response, { ok: true, thread }, 201);
  }
  if (url.pathname.match(/^\/mock\/api\/v1\/admin\/teacher-comments\/[^/]+\/status$/u) && request.method === 'POST') {
    const payload = await readBody(request); const thread = teacherThreads.find(item => url.pathname.includes(item.threadRef)); thread.status = payload.status;
    return json(response, { ok: true, thread });
  }
  const relative = decodeURIComponent(url.pathname === '/' ? '/lesson.html' : url.pathname).replace(/^\/+/, '');
  const file = path.resolve(webRoot, relative);
  if (!file.startsWith(webRoot)) { response.writeHead(403); return response.end(); }
  try {
    const content = await fs.readFile(file);
    const type = file.endsWith('.html') ? 'text/html' : file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : file.endsWith('.json') ? 'application/json' : 'application/octet-stream';
    response.writeHead(200, { 'content-type': `${type}; charset=utf-8` }); response.end(content);
  } catch { response.writeHead(404); response.end(); }
});

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe' });
await fs.mkdir(outputRoot, { recursive: true });

try {
  const desktop = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await desktop.goto(`http://127.0.0.1:${port}/lesson.html?task=writing-lesson13-young-leaders`);
  await desktop.selectOption('#lesson-class', classRef);
  await desktop.selectOption('#lesson-student', studentRef);
  await desktop.click('#lesson-identity-form button[type="submit"]');
  await desktop.waitForTimeout(500);
  if (!await desktop.locator('.lesson-body-block').count()) {
    throw new Error(`Không mở được handout: ${await desktop.locator('#lesson-identity-error').textContent()} | ${await desktop.locator('#lesson-summary').textContent()}`);
  }
  await desktop.waitForSelector('.lesson-body-block');
  assert.equal(await desktop.locator('.lesson-body-block').count(), 2);
  assert.equal(await desktop.locator('.lesson-section-workspace').count(), 6);
  assert.equal(await desktop.locator('.lesson-section-card textarea[name]').count(), 18);
  assert.equal(await desktop.locator('.comments-panel').count(), 6);
  await desktop.waitForSelector('.student-teacher-comments:not([hidden])');
  assert.equal(await desktop.locator('.teacher-comment-thread').count(), 1);
  await desktop.locator('.teacher-comment-reply textarea').fill('Em đã sửa rõ hơn ạ.');
  await desktop.locator('.teacher-comment-reply button').click();
  await desktop.waitForFunction(() => document.querySelectorAll('.teacher-comment-messages li').length === 2);
  assert.equal(await desktop.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await desktop.locator('textarea[name="body1_idea1"]').fill('Young leaders can respond quickly to new technology.');
  await desktop.locator('textarea[name="body1_idea2"]').focus();
  await desktop.waitForTimeout(250);
  await desktop.screenshot({ path: path.join(outputRoot, 'lesson13-student-desktop.png'), fullPage: true });

  const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await mobile.goto(`http://127.0.0.1:${port}/lesson.html?task=writing-lesson13-young-leaders`);
  await mobile.selectOption('#lesson-class', classRef);
  await mobile.selectOption('#lesson-student', studentRef);
  await mobile.click('#lesson-identity-form button[type="submit"]');
  await mobile.waitForSelector('.lesson-body-block');
  assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), true);
  await mobile.screenshot({ path: path.join(outputRoot, 'lesson13-student-mobile.png'), fullPage: true });

  const teacher = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  await teacher.addInitScript(() => {
    globalThis.google = { accounts: { id: { initialize(options) { globalThis.__credentialCallback = options.callback; }, renderButton(root) { const button = document.createElement('button'); button.textContent = 'Đăng nhập thử'; button.addEventListener('click', () => globalThis.__credentialCallback({ credential: 'visual-test-token' })); root.append(button); } } } };
  });
  await teacher.route('https://accounts.google.com/gsi/client', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await teacher.goto(`http://127.0.0.1:${port}/teacher.html?task=writing-lesson13-young-leaders`);
  await teacher.click('#google-signin button');
  await teacher.waitForSelector('.teacher-student-card');
  assert.equal(await teacher.locator('.teacher-student-card').count(), 1);
  await teacher.click('.teacher-student-card');
  await teacher.waitForSelector('#teacher-detail[open]');
  await teacher.waitForSelector('.teacher-comment-timeline .comment-list > li');
  assert.equal(await teacher.locator('.teacher-comment-timeline .comment-list > li').count(), 2);
  assert.equal(await teacher.locator('.teacher-detail-vocabulary tbody tr').count(), 1);
  const commentable = teacher.locator('.teacher-annotatable-text').filter({ hasText: 'Young leaders can respond quickly' });
  await commentable.selectText();
  await commentable.dispatchEvent('mouseup');
  const composer = commentable.locator('..').locator('.teacher-comment-composer');
  await composer.locator('textarea').fill('Comment thứ hai để kiểm tra neo đoạn chữ.');
  await composer.locator('button[type="submit"]').click();
  await teacher.waitForFunction(() => document.querySelectorAll('.teacher-comment-thread').length >= 2);
  const beforeAddressed = await teacher.locator('.teacher-comment-thread').count();
  await teacher.locator('.teacher-comment-status-action').first().click();
  await teacher.waitForSelector('.teacher-comment-thread[data-status="addressed"]');
  assert.equal(await teacher.locator('.teacher-comment-thread').count(), beforeAddressed);
  await teacher.screenshot({ path: path.join(outputRoot, 'lesson13-teacher-dashboard.png'), fullPage: true });
  await teacher.mouse.click(5, 5);
  await teacher.waitForFunction(() => !document.getElementById('teacher-detail').open);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log(JSON.stringify({ ok: true, studentSections: 6, fields: 18, teacherAggregateSeconds: 5 }));
