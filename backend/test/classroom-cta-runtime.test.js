import assert from 'node:assert/strict';
import test from 'node:test';
import { createK67CtaRuntime } from '../src/reading-listening67/classroom-cta-runtime.js';
import { createK67CtaHttp } from '../src/reading-listening67/classroom-cta-http.js';

const classroom = { classCode: 'IC2353', courseId: '100', classroomName: 'CTA 67', shared: true };
const registry = { class_code: classroom.classCode, course_id: classroom.courseId, course_work_id: '200',
  delivery_mode: 'docs_cta', opened_at: '2026-11-19T00:00:00Z', assignment_code: '67-speaking-paraphrase' };

test('lịch chỉ chạy lớp đã chuyển quyền và giữ kết quả một phần khi một lớp mất nguồn', async () => {
  const calls = [];
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
      return { status: 'done' };
    },
    async processJob() { throw Error('unknown outcome'); },
  });
  const result = await runtime.tick();
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.results.map(item => item.status), ['done', 'legacy_owner']);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].parentRunId, 'runtime-1');
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
