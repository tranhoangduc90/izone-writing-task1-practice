import assert from 'node:assert/strict';
import test from 'node:test';
import { createK67CtaRuntime } from '../src/reading-listening67/classroom-cta-runtime.js';
import { createK67CtaHttp, createK67CtaWorkSignal, startK67CtaLoops } from '../src/reading-listening67/classroom-cta-http.js';

const classroom = { classCode: 'IC2353', courseId: '100', classroomName: 'CTA 67', shared: true };
const registry = { class_code: classroom.classCode, course_id: classroom.courseId, course_work_id: '200',
  delivery_mode: 'docs_cta', opened_at: '2026-11-19T00:00:00Z', assignment_code: '67-speaking-paraphrase' };

test('lịch chỉ chạy lớp đã chuyển quyền và giữ kết quả một phần khi một lớp mất nguồn', async () => {
  const calls = [];
  const trace = [];
  const date = Date.parse('2026-11-19T06:17:00Z');
  const runtime = createK67CtaRuntime({
    clock: () => date,
    nativeStore: {
      async withSlot(slot, run) { assert.equal(slot.toISOString(), '2026-11-19T06:15:00.000Z'); return run('runtime-1'); },
      async ownership(course) { return course.classCode === 'IC2353' ? 4 : null; },
      async claim() { return { executionId: 'job', runId: 'run' }; },
      async settle() { assert.fail('Outcomes without proof must stay claimable'); },
    },
    async listScope() {
      return { portalClasses: 3, courses: [classroom, { classCode: 'IC2340', courseId: '500' }],
        missing: [{ classCode: 'IC2363', reason: 'classroom_mapping_pending' }] };
    },
    async resolveSpeakingCourse() { assert.fail('Existing course must be reused'); },
    async readSpeakingScopes() { return { ok: true, assignments: [registry] }; },
    async produce(input) {
      calls.push(input);
      return { status: 'done', runId: 'scan', discovered: 5, published: 1, counts: {}, speaking: [{ courseWorkId: '200' }] };
    },
    async reconcileSpeaking(scope, _snapshot, epoch) {
      assert.equal(scope.classCode, classroom.classCode);
      assert.equal(epoch, 4);
      trace.push('speaking');
      return { status: 'done' };
    },
    onWorkAvailable() { trace.push('worker'); },
    async processJob() { throw Error('unknown outcome'); },
  });
  const result = await runtime.tick();
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.results.map(item => item.status), ['done', 'legacy_owner']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parentRunId, 'runtime-1');
  assert.deepEqual(trace, ['speaking', 'worker']);
  assert.equal((await runtime.workOnce()).status, 'unknown');
});

test('route vận hành chỉ nhận token nội bộ, cùng contract danh sách Docs và lái đúng đích', async t => {
  const token = 'fixture-operator-'.repeat(3);
  const doc = 'fixture_document_123456789012345';
  const server = createK67CtaHttp({
    token, ready: async () => true,
    runtime: { async manual() { return { status: 'done', results: [{ status: 'legacy_owner' }] }; } },
    async manualDocuments(action, docs) {
      assert.equal(action, 'status');
      assert.deepEqual(docs, [{ docId: doc }]);
      return { ok: true, results: [{ docId: doc, status: 'registered' }] };
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { authorization: 'Bearer ' + token };
  assert.equal((await fetch(base + '/ready')).status, 401);
  assert.equal((await fetch(base + '/ready', { headers })).status, 200);
  assert.equal((await fetch(base + '/manual', { method: 'POST', headers,
    body: JSON.stringify({ classCode: 'IC2353' }) })).status, 409);
  const result = await fetch(base + '/manual-docs/status', { method: 'POST', headers,
    body: JSON.stringify({ docs: [{ docId: doc }] }) });
  assert.equal(result.status, 200);
  assert.deepEqual(await result.json(), { ok: true, results: [{ docId: doc, status: 'registered' }] });
});

test('trang CTA dùng phiên vận hành cho cả hai nút và giữ các route nội bộ riêng', async t => {
  const token = 'fixture-operator-'.repeat(3);
  const origin = 'https://fixture.github.io';
  const docId = 'fixture_document_123456789012345';
  const actions = [];
  const events = [];
  const server = createK67CtaHttp({
    token, log(event) { events.push(event); },
    manualPage: { origin, async authorize(req) {
      const state = req.headers.cookie;
      if (state !== 'operator') throw Object.assign(new Error('test auth'), {
        status: state === 'teacher' ? 403 : state === 'broker_unavailable' ? 503 : 401,
      });
    } },
    async manualDocuments(action, docs) {
      actions.push(action);
      assert.deepEqual(docs, [{ docId }]);
      return { ok: true, results: [{ docId, status: action === 'submit' ? 'queued' : 'registered' }] };
    },
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { Origin: origin, 'X-Izone-Csrf': '1' };
  const body = JSON.stringify({ docs: [{ docId }] });
  const send = (path, params) => fetch(base + path, { method: 'POST', body, ...params });
  const submit = '/operator/cta/submit';
  const status = '/operator/cta/status';
  const preflight = await fetch(base + submit, { method: 'OPTIONS', headers: { Origin: origin } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-credentials'), 'true');
  const unsafeOrigin = await send(submit, { headers: { ...headers, Origin: 'https://other.test', Cookie: 'operator' } });
  assert.equal(unsafeOrigin.status, 403);
  assert.equal(unsafeOrigin.headers.get('access-control-allow-origin'), null);
  assert.equal((await send(submit, { headers: { Origin: origin, Cookie: 'operator' } })).status, 403);
  assert.equal((await send(submit, { headers: { ...headers, Authorization: 'Bearer ' + token } })).status, 401);
  assert.equal((await send(submit, { headers: { ...headers, Cookie: 'teacher' } })).status, 403);
  assert.equal((await send(status, { headers: { ...headers, Cookie: 'broker_unavailable' } })).status, 503);
  assert.equal((await send('/manual-docs/submit', { headers: { ...headers, Cookie: 'operator' } })).status, 401);
  assert.deepEqual(actions, []);
  for (const [path, expected] of [[submit, 'queued'], [status, 'registered']]) {
    const reply = await send(path, { headers: { ...headers, Cookie: 'operator' } });
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('access-control-allow-origin'), origin);
    assert.deepEqual(await reply.json(), { ok: true, results: [{ docId, status: expected }] });
  }
  assert.deepEqual(actions, ['submit', 'status']);
  assert.deepEqual(events.map(event => event.stage), [
    'manual_page_auth', 'manual_page_auth', 'manual_page_auth', 'manual_page', 'manual_page',
  ]);
  assert.equal(JSON.stringify(events).includes(docId), false);
});

test('worker nhận tín hiệu khi job đến trong hoặc sau một lần claim trống', { timeout: 2000 }, async t => {
  const workSignal = createK67CtaWorkSignal();
  const emptyClaim = Promise.withResolvers();
  const secondClaim = Promise.withResolvers();
  const thirdClaim = Promise.withResolvers();
  let claims = 0;
  const stop = startK67CtaLoops({ workSignal, runtime: {
    async tick() {},
    async workOnce() {
      claims++;
      if (claims === 1) return emptyClaim.promise;
      if (claims === 2) secondClaim.resolve();
      if (claims === 3) thirdClaim.resolve();
      return { status: 'idle' };
    },
  } });
  t.after(stop);
  workSignal.notify();
  emptyClaim.resolve({ status: 'idle' });
  await secondClaim.promise;
  await new Promise(resolve => setImmediate(resolve));
  workSignal.notify();
  await thirdClaim.promise;
  await stop();
  assert.equal(claims, 3);
});
