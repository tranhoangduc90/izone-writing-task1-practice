import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { z } from 'zod';
import { createLessonPracticeService } from '../../backend/src/lesson-service.js';
import { createTeacherClassAccessService } from '../../backend/src/teacher-class-access.js';
import { createLesson9Service } from '../../backend/ops/sw-task2-production/lesson9-service.js';
import { createWritingPracticeService } from '../../backend/ops/sw-task2-production/service-runtime.js';
import { createApp } from '../src/app.mjs';
import { createSwRosterApi } from '../vendor/sw-roster-api.mjs';
import { createSwRosterProjection } from '../vendor/sw-roster-projection.mjs';
import { createSwRosterRegistry } from '../vendor/sw-roster-registry.mjs';
import { adapt, setup } from '../test/helpers.mjs';

const pagesRoot = process.env.SW_ROSTER_PAGES_ROOT || fileURLToPath(new URL('../../../pages/', import.meta.url));
const { chromium } = createRequire(resolve(process.env.USERPROFILE,
  '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/package.json'))('playwright');
const currentTask1 = 'pie-app-users-by-age';
const currentTask2 = 'writing-task2-living-alone-development';
const futureTask1 = 'australian-destinations-1999-2009';
const futureTask2 = 'writing-task2-public-health-ban';
const classCode = 'CS.999001';
const teacherEmail = 'teacher@fixture.invalid';
const outsiderEmail = 'outsider@fixture.invalid';
const sql = path => readFile(new URL(path, import.meta.url), 'utf8');
const identity = req => {
  const email = /(?:^|; *)sw_fixture_teacher=(allowed|outsider)(?:;|$)/u.exec(req.get('cookie') || '')?.[1];
  if (!email) throw Object.assign(Error('Missing fixture identity'), { status: 401 });
  return email === 'allowed' ? teacherEmail : outsiderEmail;
};

async function openScope(pool, slug, gradingPool) {
  const { rows: [{ id }] } = await pool.query(`
    INSERT INTO writing_practice.activity
      (slug,content_version,manifest_checksum,title,task_prompt,prompt_record_ref,prompt_version,end_date,status,grading_pool)
    VALUES($1,'test',repeat('a',64),'Đề thử','Đề bài','fixture','test','2030-12-31','active',$2) RETURNING id`,
  [slug, gradingPool]);
  const { rows: [scope] } = await pool.query(`
    INSERT INTO writing_practice.activity_class_scope(activity_id,erp_course_class_id,class_name_snapshot,end_date)
    VALUES($1,999001,$2,'2030-12-31') RETURNING public_id`, [id, classCode]);
  if (gradingPool === 'task2') {
    await pool.query(`INSERT INTO writing_practice.activity_section_definition
      (activity_id,section_key,title,sort_order,input_fields)
      VALUES($1,'topic_sentence','Câu chủ đề',1,'["topic_sentence","body1_idea1","body1_idea2","body_choice"]'),
        ($1,'supporting_idea_1','Ý 1',2,'["idea1_a","idea1_x","idea1_b"]'),
        ($1,'supporting_idea_2','Ý 2',3,'["idea2_a","idea2_x","idea2_b"]'),
        ($1,'draft','Draft',4,'["draft1","draft2"]')`, [id]);
    await pool.query(`INSERT INTO writing_practice.lesson9_rollout(activity_id,ui_version)
      VALUES($1,'shops-lesson9-v1')`, [id]);
  }
  return scope.public_id;
}

test('both SW dashboards enter the real native session immediately and carry pending identity into future handouts', async t => {
  const one = await setup(t);
  const twoDb = new PGlite();
  t.after(() => twoDb.close());
  const registryDb = new PGlite();
  t.after(() => registryDb.close());
  const twoPool = adapt(twoDb);
  const projectionSql = await sql('../db/005-sw-roster-projection.sql');
  await one.db.exec(projectionSql);
  await twoDb.exec(await sql('../db/001-initial.sql'));
  await twoDb.exec(projectionSql);
  await registryDb.exec(await sql('../../backend/ops/sw-task2-production/sw-roster-registry.sql'));
  await twoDb.exec(await sql('../../docs/migrations/2026-10-24-lesson9-versioned-session.sql'));
  await twoDb.exec(`
    ALTER TABLE writing_practice.activity_section_definition
      ADD COLUMN prerequisite_sections jsonb NOT NULL DEFAULT '[]';
    ALTER TABLE writing_practice.session_section
      DROP CONSTRAINT session_section_section_key_check,
      ADD CONSTRAINT session_section_section_key_check CHECK (section_key ~ '^[a-z0-9][a-z0-9_]{1,79}$');
    CREATE SCHEMA mapping;
    CREATE TABLE mapping.reviewer_class_access (reviewer_email text,erp_course_class_id bigint);
    CREATE TABLE mapping.lark_export_teacher_assignments (payload jsonb,scope_class_ids bigint[],source_status text);
    INSERT INTO mapping.reviewer_class_access VALUES('teacher@fixture.invalid',999001);
  `);
  await one.pool.query('UPDATE writing_practice.activity SET slug=$1 WHERE id=$2', [currentTask1, one.activity.id]);
  await one.pool.query('UPDATE writing_practice.activity_class_scope SET class_name_snapshot=$1', [classCode]);
  await one.pool.query("UPDATE writing_practice.activity_session SET overview='Bản cũ thuộc người khác' WHERE public_id=$1", [one.sessionRef]);
  for (const [email, refs] of [[teacherEmail, [one.classRef]], [outsiderEmail, []]]) {
    await one.pool.query('INSERT INTO task1_private.teacher_grant VALUES($1,$2,$3,true,$4::uuid[])',
      [email, email, 'teacher', refs]);
  }
  const twoClassRef = await openScope(twoPool, currentTask2, 'task2');
  const root = express();
  const tls = process.env.SW_ROSTER_FIXTURE_TLS;
  const server = tls
    ? createHttpsServer({ key: await readFile(resolve(tls, 'key.pem')), cert: await readFile(resolve(tls, 'cert.pem')) }, root)
      .listen(0, '127.0.0.1')
    : root.listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = tls ? `https://pages.sw-fixture.test:${server.address().port}` : `http://127.0.0.1:${server.address().port}`;
  const apiOrigin = tls ? `https://api.izone-fixture.test:${server.address().port}` : origin;
  const origins = new Set([origin]);
  const registry = createSwRosterRegistry({ pool: adapt(registryDb), invitationKey: 'fixture-only-key-'.repeat(3) });
  let failPeer = true;
  const peerProjection = createSwRosterProjection({ pool: twoPool, product: 'task2' });
  const peerApply = peerProjection.apply;
  peerProjection.apply = (scope, member) => {
    if (failPeer && scope.activitySlug === currentTask2) {
      throw Object.assign(Error('fixture destination down'), { code: 'FIXTURE_PEER_DOWN' });
    }
    return peerApply(scope, member);
  };
  const makeRoster = (product, projection) => createSwRosterApi({
    z, product, registry, projection, allowedOrigins: origins,
    allowAdds: true, cookieSecure: Boolean(tls), log: () => {},
  });
  const task1Roster = makeRoster('task1', createSwRosterProjection({ pool: one.pool, product: 'task1' }));
  const task2Roster = makeRoster('task2', peerProjection);
  const task1 = createApp({ ...one, config: { origins }, swRoster: task1Roster,
    verifyTeacher: async req => ({ email: identity(req), sub: identity(req) }) });
  const task2 = express();
  task2.use(express.json());
  task2.use((req, res, next) => {
    if (req.get('origin') === origin) {
      res.set('Access-Control-Allow-Origin', origin).set('Access-Control-Allow-Credentials', 'true');
      if (req.method === 'OPTIONS') {
        return res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS')
          .set('Access-Control-Allow-Headers', 'Content-Type,X-Izone-Csrf,If-None-Match').sendStatus(204);
      }
    }
    next();
  });
  const access = createTeacherClassAccessService({ pool: twoPool });
  const teacher = (req, _res, next) => { req.reviewer = { email: identity(req), role: 'teacher' }; next(); };
  const assertTeacher = (req, scope) => access.assertActivityClass(req.reviewer, scope);
  const task2Service = createWritingPracticeService({ pool: twoPool });
  const lesson = createLesson9Service({ pool: twoPool, lessonService: createLessonPracticeService({ pool: twoPool }) });
  task2Roster.install(task2, { teacher, assertTeacher, getRoster: task2Service.getRoster, writeLimit: (_q, _r, n) => n() });
  task2.get('/api/v1/sw/status', (_q, r) => r.json({ ok: true }));
  task2.get('/api/v1/auth/session', teacher, (q, r) => r.json({ ok: true, reviewer: q.reviewer }));
  task2.get('/api/v1/admin/me', teacher, async (q, r) => r.json({
    reviewer: q.reviewer, classes: await access.listClasses(q.reviewer),
  }));
  task2.get('/api/v1/activities/:slug/roster', async (q, r) => {
    await task2Roster.syncActivity(q.params.slug);
    r.json(await task2Roster.enrichRoster(q.params.slug, await task2Service.getRoster(q.params.slug)));
  });
  task2.get('/api/v1/admin/activities/:slug/roster', teacher, async (q, r) => {
    const allowed = new Set((await access.listClasses(q.reviewer)).map(item => item.classCode));
    const roster = await task2Service.getRoster(q.params.slug);
    r.json({ classes: roster.classes.filter(group => allowed.has(group.className)),
      permissions: { swClassRoster: true, swClassRosterAdds: true } });
  });
  // Overview statistics are outside this fixture; membership comes from the native roster DB.
  task2.get('/api/v1/admin/sw/lesson9/overview/:slug', teacher, async (q, r) => {
    const scope = { activitySlug: q.params.slug, classRef: q.query.classRef };
    await assertTeacher(q, scope);
    r.json({ ...scope, students: [] });
  });
  task2.post('/api/v1/lesson9/sessions', async (q, r) => r.status(201).json({ session: await lesson.open(q.body) }));
  task2.get('/api/v1/lesson9/sessions/:ref', async (q, r) => r.json({ session: await lesson.details(q.params.ref) }));
  task2.get('/api/v1/sessions/:ref/teacher-comments', (_q, r) => r.json({ threads: [] }));
  task2.use((err, _q, r, _n) => r.status(err.status || 500).json({ error: err.code, message: err.message }));
  root.use('/writing-api', task1);
  root.use('/shops-writing-api', task2);
  root.get('/writing-handouts/config.json', async (_q, r) => {
    const original = JSON.parse(await readFile(resolve(pagesRoot, 'writing-handouts/config.json'), 'utf8'));
    r.json({ ...original, apiBase: apiOrigin + '/writing-api/', studentMemory: { enabled: false } });
  });
  root.get('/sw-task2-writing/writing-handouts/shops-review/https-runtime.js', (_q, r) => r
    .type('js').send(`window.IZONE_SHOPS={apiBase:${JSON.stringify(apiOrigin + '/shops-writing-api/api/v1/')}};`));
  root.get(['/shared/teacher-single-sign-on.js', '/sw-task2-writing/shared/teacher-single-sign-on.js'], (_q, r) =>
    r.type('js').send('window.IzoneTeacherSso={restore:async()=>true};'));
  if (tls) root.get(['/writing-handouts/index.html', '/writing-handouts/teacher.html',
    '/sw-task2-writing/index.html', '/sw-task2-writing/teacher.html'], async (q, r) => {
    const html = await readFile(resolve(pagesRoot, '.' + q.path), 'utf8');
    r.type('html').send(html.replace('https://ducizone.ddns.net', apiOrigin));
  });
  root.use(express.static(pagesRoot));

  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: tls ? [
    '--no-proxy-server', '--host-resolver-rules=MAP pages.sw-fixture.test 127.0.0.1,MAP api.izone-fixture.test 127.0.0.1',
  ] : [] });
  t.after(() => browser.close());
  const browserContext = async (cookie, width = 1280) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: Boolean(tls) });
    await context.route('**/*', route => [origin, apiOrigin].includes(new URL(route.request().url()).origin)
      ? route.continue() : route.abort());
    if (cookie) await context.addCookies([{ name: 'sw_fixture_teacher', value: cookie, url: apiOrigin,
      ...(tls ? { secure: true, sameSite: 'None', partitionKey: origin } : {}) }]);
    return context;
  };
  const teacherContext = await browserContext('allowed');
  const studentContext = await browserContext(null, 390);
  const teacherPage = await teacherContext.newPage();
  const studentPage = await studentContext.newPage();
  const task2SaveRequests = [];
  teacherPage.on('request', req => {
    if (req.method() === 'POST' && req.url().endsWith('/' + currentTask2 + '/class-members')) {
      task2SaveRequests.push(req.postDataJSON().requestId);
    }
  });
  const entry = (folder, page, task, classRef) =>
    `${origin}/${folder}/${page}.html?task=${task}&class=${classRef}`;
  const oneTeacher = entry('writing-handouts', 'teacher', currentTask1, one.classRef);
  const twoTeacher = entry('sw-task2-writing', 'teacher', currentTask2, twoClassRef);

  async function addName(url, displayName, duplicate, losesResponse = false) {
    await teacherPage.goto(url);
    await teacherPage.getByRole('button', { name: 'Thêm học viên', exact: true }).click();
    const form = teacherPage.locator('.sw-roster-dialog form');
    assert.equal(await form.locator('input').count(), 1);
    if (losesResponse) await teacherPage.evaluate(() => {
      const original = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        const response = await original(url, options);
        if (options?.method === 'POST' && String(url).endsWith('/class-members') && response.status === 201) {
          globalThis.fetch = original;
          throw new TypeError('Fixture dropped the response after server commit.');
        }
        return response;
      };
    });
    await form.getByRole('textbox', { name: 'Họ và tên' }).fill(displayName);
    await form.getByRole('button', { name: 'Lưu', exact: true }).click();
    if (duplicate) await form.getByRole('button', { name: 'Thêm người khác cùng tên' }).click();
    if (losesResponse) {
      await teacherPage.getByText('Chưa nhận được phản hồi. Bấm Lưu để thử lại.').waitFor();
      await teacherPage.reload();
      await teacherPage.getByRole('button', { name: 'Thêm học viên', exact: true }).click();
      await form.getByRole('textbox', { name: 'Họ và tên' }).fill(displayName);
      await form.getByRole('button', { name: 'Lưu', exact: true }).click();
    }
    const link = teacherPage.getByRole('link', { name: 'Mở liên kết vào bài' });
    await link.waitFor();
    assert.match(await teacherPage.locator('.sw-roster-dialog [role=status]').innerText(), /Có thể làm bài ngay/u);
    return link.getAttribute('href');
  }

  const firstLink = await addName(oneTeacher, 'Học viên thử', true);
  const firstOpen = studentPage.waitForResponse(resp => resp.url().endsWith('/api/v1/sessions') && resp.status() === 201);
  await studentPage.goto(firstLink);
  await studentPage.locator('#workspace').waitFor({ state: 'visible' });
  const { session: first } = await (await firstOpen).json();
  assert.notEqual(first.studentRef, one.studentRef);
  assert.doesNotMatch(studentPage.url(), /sw-invite/u);
  if (tls) {
    const cookies = await studentContext.cookies(apiOrigin);
    const credential = cookies.find(item => item.name === '__Host-izone_sw_' + first.studentRef);
    assert.equal(credential?.httpOnly, true);
    assert.equal(credential?.secure, true);
    assert.ok(credential.partitionKey);
  }
  assert.equal((await one.service.sessionDetails(one.sessionRef)).overview, 'Bản cũ thuộc người khác');
  await task2Roster.runSweep();
  const partial = (await registry.listDelivery('999001')).find(item => item.product === 'task2');
  assert.equal(partial.targets[0].error, 'FIXTURE_PEER_DOWN');
  assert.equal(partial.targets[0].status, 'pending');
  failPeer = false;
  await task2Roster.runSweep();
  const caughtUp = (await registry.listDelivery('999001')).find(item => item.product === 'task2');
  assert.equal(caughtUp.targets[0].status, 'ready');
  await teacherPage.reload();
  await teacherPage.getByRole('button', { name: 'Thêm học viên', exact: true }).click();
  await teacherPage.locator('.sw-roster-dialog').getByText(/Học viên thử · Chờ đối soát ERP/u).waitFor();

  const later1 = await openScope(one.pool, futureTask1, 'task1');
  const later2 = await openScope(twoPool, futureTask2, 'task2');
  const oneLater = await studentContext.newPage();
  await oneLater.goto(entry('writing-handouts', 'index', futureTask1, later1));
  await oneLater.locator('#student-name').selectOption(first.studentRef);
  const laterOpen1 = oneLater.waitForResponse(resp => resp.url().endsWith('/api/v1/sessions') && resp.status() === 201);
  await oneLater.locator('#identity-form button[type=submit]').click();
  await oneLater.locator('#confirm-open').click();
  await oneLater.locator('#workspace').waitFor({ state: 'visible' });
  assert.equal((await (await laterOpen1).json()).session.studentRef, first.studentRef);

  const twoLater = await studentContext.newPage();
  await twoLater.goto(entry('sw-task2-writing', 'index', futureTask2, later2));
  await twoLater.locator('#identity-person').selectOption(first.studentRef);
  const laterOpen2 = twoLater.waitForResponse(resp => resp.url().endsWith('/lesson9/sessions') && resp.request().method() === 'POST');
  await twoLater.getByRole('button', { name: /Tiếp tục/u }).click();
  await twoLater.getByRole('button', { name: /Đúng là tôi/u }).click();
  const laterResponse2 = await laterOpen2;
  assert.equal(laterResponse2.status(), 201, await laterResponse2.text());
  await twoLater.locator('#save-state').waitFor();
  assert.equal((await laterResponse2.json()).session.studentRef, first.studentRef);
  assert.equal((await registry.listActive('999001'))[0].reconciliationStatus, 'pending_erp');

  const secondLink = await addName(twoTeacher, 'Người học mới Task 2', false, true);
  assert.equal(task2SaveRequests.length, 2);
  assert.equal(task2SaveRequests[0], task2SaveRequests[1]);
  const secondOpen = studentPage.waitForResponse(resp => resp.url().endsWith('/lesson9/sessions') && resp.status() === 201);
  await studentPage.goto(secondLink);
  await studentPage.locator('#save-state').waitFor();
  const { session: second } = await (await secondOpen).json();
  assert.notEqual(second.studentRef, first.studentRef);
  await teacherPage.reload();
  await teacherPage.getByRole('button', { name: 'Thêm học viên', exact: true }).click();
  await teacherPage.locator('.sw-roster-dialog').getByText(/Người học mới Task 2 · Chờ đối soát ERP/u).waitFor();
  assert.equal(await studentPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const outsider = await browserContext('outsider');
  const outsiderPage = await outsider.newPage();
  await outsiderPage.goto(origin + '/shared/sw-class-roster.css');
  const denied = await outsiderPage.evaluate(async ({ url, classRef }) => {
    const response = await fetch(url, { method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-Izone-Csrf': '1' },
      body: JSON.stringify({ classRef, requestId: '16a15654-fef4-431c-9d6c-40801013aaa9', displayName: 'Ngoài quyền' }),
    });
    return response.status;
  }, {
    url: apiOrigin + '/shops-writing-api/api/v1/admin/activities/' + currentTask2 + '/class-members',
    classRef: twoClassRef,
  });
  assert.equal(denied, 403);
  await Promise.all([task1Roster.runSweep(), task2Roster.runSweep()]);
});
