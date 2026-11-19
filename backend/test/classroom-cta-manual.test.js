import assert from 'node:assert/strict';
import test from 'node:test';
import { createK67ManualDocuments } from '../src/reading-listening67/classroom-cta-manual.js';
import { createK67InternalClient, createK67PortalClient, createK67SpeakingClient } from '../src/reading-listening67/classroom-cta-clients.js';

const first = 'fixture_document_123456789012345';
const second = 'different_document_1234567890123';
const third = 'confirmed_document_1234567890123';

test('gửi theo từng Docs, từ chối nguồn mơ hồ và kiểm trạng thái qua proof', async () => {
  const writes = [];
  const c = { classCode: 'IC2353', courseId: '100', courseWorkId: '200', epoch: 5 };
  const manual = createK67ManualDocuments({
    nativeStore: { async manualSource(id) {
      if (id === second) return { status: 'source_ambiguous' };
      if (id === third) return { status: 'eligible', ...c, state: 'ready',
        proof: [{ documentId: third, status: 'verified' }] };
      return { status: 'eligible', ...c, state: 'pending', enqueued: true };
    } },
    listScope: async () => ({ courses: [{ courseId: '100', classCode: 'IC2353' }] }),
    async produce(input) {
      writes.push(input);
      return { status: 'done', published: 1 };
    },
    async readCodes(id) { assert.equal(id, third); return ['67-listening-scandinavian-studies']; },
  });
  const items = [first, second, third].map(docId => ({ docId }));
  assert.deepEqual((await manual('submit', items)).results, [
    { docId: first, status: 'queued' }, { docId: second, status: 'source_ambiguous' },
    { docId: third, status: 'registered', codes: ['67-listening-scandinavian-studies'] },
  ]);
  assert.deepEqual(writes, [{ ...c, documentId: first, speaking: [] }]);
  assert.deepEqual((await manual('status', items)).results.map(x => x.status), ['queued', 'source_ambiguous', 'registered']);
  assert.equal(writes.length, 1);
  await assert.rejects(manual('submit', [items[0], items[0]]), { code: 'CTA_MANUAL_BATCH_INVALID' });
});

test('đường Speaking dùng header worker và field plan thật, chặn URL rời origin', async () => {
  const token = 'fixture-secret-'.repeat(3);
  const request = createK67InternalClient({
    origin: 'https://fixture.invalid/mapping-api', token, credentialHeader: 'x-speaking-worker-secret',
    async fetcher(url, options) {
      assert.equal(url, 'https://fixture.invalid/mapping-api/api/speaking-homework/internal/classroom-copies/plan');
      assert.equal(options.headers['x-speaking-worker-secret'], token);
      assert.equal(options.redirect, 'error');
      assert.deepEqual(JSON.parse(options.body), { documentId: first, document: {} });
      return Response.json({ ok: true, plan: { revisionId: 'r1', requests: [] } });
    },
  });
  const api = createK67SpeakingClient(request);
  assert.deepEqual(await api.plan({ documentId: first, document: {} }), { revisionId: 'r1', requests: [] });
  await assert.rejects(request('//foreign.invalid/path'), { code: 'CTA_NATIVE_PATH_INVALID' });
});

test('Portal tái sử dụng phiên và lấy lại đúng một lần khi nhận 401', async () => {
  const origin = 'https://metabase.izone.edu.vn';
  const credentials = { username: 'fixture@example.test', password: 'fixture-password' };
  const payload = { database: 2 };
  const paths = [];
  let logins = 0, datasets = 0;
  const portal = createK67PortalClient({ origin, credentials, onRequest: event => paths.push(event), async fetcher(href, request) {
    assert.equal(request.redirect, 'error');
    if (href === origin + '/api/session') {
      assert.deepEqual(JSON.parse(request.body), credentials);
      return Response.json({ id: 'x'.repeat(32) + String(++logins) });
    }
    assert.equal(href, origin + '/api/dataset');
    assert.equal(request.headers['x-metabase-session'], 'x'.repeat(32) + String(logins));
    assert.deepEqual(JSON.parse(request.body), payload);
    return ++datasets === 2 ? new Response('expired', { status: 401 }) : Response.json({ ok: true });
  } });
  assert.deepEqual(await portal('/api/dataset', payload), { ok: true });
  assert.deepEqual(await portal('/api/dataset', payload), { ok: true });
  assert.deepEqual(await portal('/api/dataset', payload), { ok: true });
  assert.equal(logins, 2);
  assert.equal(datasets, 4);
  assert.deepEqual(paths.map(event => event.path), ['/api/session', '/api/dataset', '/api/dataset', '/api/session', '/api/dataset', '/api/dataset']);
  assert.throws(() => createK67PortalClient({ origin: 'https://elsewhere.invalid', credentials }), { code: 'CTA_PORTAL_CREDENTIALS_INVALID' });
  await assert.rejects(portal('/api/card', {}), { code: 'CTA_PORTAL_PATH_INVALID' });
});
