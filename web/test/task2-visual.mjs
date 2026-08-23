// Dữ liệu nhận vào: manifest Task 2, API giả và bài hoàn thành hoàn toàn bằng dữ liệu kiểm thử.
// Việc chính: mở giao diện desktop/mobile, kiểm tra đủ bốn bước và mô phỏng nút Check khi API phản hồi chậm.
// Kết quả: ba ảnh PNG trong output/playwright và xác nhận ba lần bấm nhanh chỉ tạo một lượt Check giả.
// Khi lỗi: script trả exit code khác 0 và chỉ rõ thành phần giao diện bị thiếu hoặc tràn ngang.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('C:/Users/ADMIN/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
const webRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRoot = path.resolve(webRoot, '..', 'output', 'playwright');
const sessionRef = '11111111-1111-4111-8111-111111111111';
const studentRef = '22222222-2222-4222-8222-222222222222';
const classRef = '33333333-3333-4333-8333-333333333333';
const attemptRef = '44444444-4444-4444-8444-444444444444';
let scenario = 'completed';
let saveRequests = 0;
let checkRequests = 0;
const responses = {
  body1_message: 'Body 1 giải thích lợi ích chính.', body1_idea1: 'Lợi ích thứ nhất.', body1_idea2: 'Lợi ích thứ hai.',
  body2_message: 'Body 2 giải thích giới hạn.', body2_idea1: 'Giới hạn thứ nhất.', body2_idea2: 'Giới hạn thứ hai.',
  body_choice: 'body1', topic_sentence: 'This body explains two main benefits.',
  idea1_a: 'A1', idea1_x: 'X1', idea1_b: 'B1', idea2_a: 'A2', idea2_x: 'X2', idea2_b: 'B2',
  draft1: 'This body explains <hai lợi ích chính> through two connected ideas.',
  draft2: 'This body explains two main benefits through two connected ideas.',
};
const sections = Object.fromEntries(['topic_sentence','supporting_idea_1','supporting_idea_2','draft'].map(key => [key,{status:'passed',attemptsWithoutPass:0}]));
const comments = [
  { section:'topic_sentence',commentNumber:1,status:'completed',feedback:'👍 Đã đạt.',createdAt:'2026-08-19T01:00:00Z' },
  { section:'supporting_idea_1',commentNumber:1,status:'completed',feedback:'👍 Đã đạt.',createdAt:'2026-08-19T01:01:00Z' },
  { section:'supporting_idea_2',commentNumber:1,status:'completed',feedback:'👍 Đã đạt.',artifacts:{vocabulary:[{idea:'trình bày lợi ích',terms:['explain the benefit']},{idea:'tạo kết quả tích cực',terms:['lead to a positive outcome']},{idea:'kết nối hai ý',terms:['connect the two ideas']}]},createdAt:'2026-08-19T01:02:00Z' },
  { section:'draft',commentNumber:1,status:'completed',feedback:'https://practice.izone.edu.vn/shared/writing-essays/demo-task2/edit?page=0',artifacts:{lmsUrl:'https://practice.izone.edu.vn/shared/writing-essays/demo-task2/edit?page=0'},createdAt:'2026-08-19T01:03:00Z' },
];
const waitingSections = {
  topic_sentence:{status:'passed',attemptsWithoutPass:0},
  supporting_idea_1:{status:'revision',attemptsWithoutPass:2},
  supporting_idea_2:{status:'draft',attemptsWithoutPass:0},
  draft:{status:'draft',attemptsWithoutPass:0},
};
const session = () => scenario === 'waiting'
  ? ({sessionRef,draftVersion:1,responses,sections:waitingSections,comments:comments.slice(0,2),attempts:[],updatedAt:'2026-08-19T01:03:00Z'})
  : ({sessionRef,draftVersion:1,responses,sections,comments,attempts:[],updatedAt:'2026-08-19T01:03:00Z'});

function json(response,value,status=200,headers={}) {
  response.writeHead(status,{'content-type':'application/json; charset=utf-8',...headers});
  response.end(JSON.stringify(value));
}

const server = http.createServer(async (request,response) => {
  const url = new URL(request.url,'http://local.test');
  const api = '/mock/api/v1';
  if (url.pathname === '/config.json') return json(response,{apiBase:`http://127.0.0.1:${server.address().port}/mock/`,googleClientId:'visual-test'});
  if (url.pathname === `${api}/activities/writing-task2-practice-template/roster`) return json(response,{ok:true,classes:[{classRef,className:'Lớp kiểm thử',students:[{studentRef,alias:'Học viên kiểm thử'}]}]});
  if (url.pathname === `${api}/lesson-sessions` && request.method === 'POST') return json(response,{ok:true,session:{sessionRef}},201);
  if (url.pathname === `${api}/lesson-sessions/${sessionRef}`) return json(response,{ok:true,session:session()});
  if (url.pathname === `${api}/lesson-sessions/${sessionRef}/responses` && request.method === 'PUT') {
    saveRequests += 1;
    await new Promise(resolve => setTimeout(resolve,400));
    return json(response,{ok:true,session:session()});
  }
  if (url.pathname === `${api}/lesson-sessions/${sessionRef}/checks` && request.method === 'POST') {
    checkRequests += 1;
    await new Promise(resolve => setTimeout(resolve,100));
    return json(response,{ok:true,attempt:{attemptRef,commentRef:'55555555-5555-4555-8555-555555555555',section:'supporting_idea_1',commentNumber:3,status:'queued',version:1}},202);
  }
  if (url.pathname === `${api}/lesson-sessions/${sessionRef}/draft-result`) {
    const fixture=JSON.parse(await fs.readFile(path.join(webRoot,'demo-lms-draft-result.json'),'utf8'));
    return json(response,{ok:true,result:{...fixture.lmsResponse,updatedAt:'2026-08-19T01:03:00Z'}});
  }
  if (url.pathname === `${api}/lesson-sessions/${sessionRef}/live`) return json(response,{ok:true,accepted:true});
  if (url.pathname === `${api}/sessions/${sessionRef}/teacher-comments`) return json(response,{ok:true,threads:[]},200,{etag:'"task2-comments-0"'});
  const relative=decodeURIComponent(url.pathname === '/' ? '/lesson.html' : url.pathname).replace(/^\/+/, '');
  const file=path.resolve(webRoot,relative);
  if(!file.startsWith(webRoot)){response.writeHead(403);return response.end();}
  try {
    const content=await fs.readFile(file);
    const type=file.endsWith('.html')?'text/html':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':file.endsWith('.json')?'application/json':'application/octet-stream';
    response.writeHead(200,{'content-type':`${type}; charset=utf-8`}); response.end(content);
  } catch { response.writeHead(404); response.end(); }
});

await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const port=server.address().port;
const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'});
await fs.mkdir(outputRoot,{recursive:true});

async function openCompleted(viewport,filename) {
  const page=await browser.newPage({viewport});
  await page.goto(`http://127.0.0.1:${port}/lesson.html?task=writing-task2-practice-template`);
  await page.selectOption('#lesson-class',classRef);
  await page.selectOption('#lesson-student',studentRef);
  await page.click('#lesson-identity-form button[type="submit"]');
  await page.waitForSelector('.lms-sentence-card');
  assert.equal(await page.locator('.lesson-body-block').count(),2);
  assert.equal(await page.locator('.lesson-section-workspace').count(),4);
  assert.equal(await page.locator('.lesson-section-card textarea[name]').count(),15);
  assert.equal(await page.locator('input[type="radio"][name="body_choice"]').count(),2);
  assert.equal(await page.locator('.task2-draft-vocabulary tbody tr').count(),3);
  assert.ok(await page.locator('.lms-sentence-card').count()>0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),true);
  await page.screenshot({path:path.join(outputRoot,filename),fullPage:true});
  await page.close();
}

async function checkSlowSubmission() {
  scenario='waiting';
  const page=await browser.newPage({viewport:{width:1280,height:900}});
  await page.goto(`http://127.0.0.1:${port}/lesson.html?task=writing-task2-practice-template`);
  await page.selectOption('#lesson-class',classRef);
  await page.selectOption('#lesson-student',studentRef);
  await page.click('#lesson-identity-form button[type="submit"]');
  const selector='[data-section="supporting_idea_1"] .submit-section';
  await page.fill('[data-section="supporting_idea_1"] textarea[name="idea1_a"]','A1 đã chỉnh');
  await page.locator(selector).evaluate(button => { button.click(); button.click(); button.click(); });
  await page.waitForFunction(value => document.querySelector(value)?.textContent === 'Đang gửi bài…',selector);
  assert.equal(await page.locator(selector).isDisabled(),true);
  await page.waitForFunction(value => document.querySelector(value)?.textContent === 'Đang chấm — không cần bấm lại',selector);
  assert.equal(saveRequests,1);
  assert.equal(checkRequests,1);
  await page.screenshot({path:path.join(outputRoot,'task2-check-waiting.png'),fullPage:true});
  await page.close();
}

try {
  await openCompleted({width:1440,height:1000},'task2-student-desktop.png');
  await openCompleted({width:390,height:844},'task2-student-mobile.png');
  await checkSlowSubmission();
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

console.log(JSON.stringify({ok:true,sections:4,textareas:15,vocabularyRows:3,saveRequests,checkRequests}));
