import assert from 'node:assert/strict';
import test from 'node:test';
import { createGoogleDocsAccount, createGoogleDocsTokenProvider, docsAccountEmails } from '../src/google-docs-write/google.js';
import { executeDocsWrite } from '../src/google-docs-write/execute.js';

function fixture({ reader = false, fallbackReader = false, fallbackMissing = false,
  quota = false, lostResponse = false, applied = true } = {}) {
  const documentId = 'test-document';
  const tabId = 'test-tab';
  const input = { product: 'speaking', eventId: 'test-event', resultVersion: 1, binding: { documentId, tabId } };
  const trace = [];
  let content = '';
  let revision = 1;
  let position = tabId;
  let rejectSource = false;
  let reconciliation;
  const accounts = Object.fromEntries(Object.entries(docsAccountEmails).map(([role, email]) => [role,
    createGoogleDocsAccount({ role, getToken: async () => role, fetcher: async (url, options) => {
      assert.equal(options.headers.authorization, `Bearer ${role}`);
      const path = new URL(url).pathname;
      const readOnly = role === 'primary' ? reader : fallbackReader;
      if (path.endsWith('/about')) return Response.json({ user: { emailAddress: email } });
      if (options.method === 'GET' && role === 'fallback' && fallbackMissing) {
        trace.push(path.includes('/files/') ? 'capability:fallback' : 'read:fallback');
        return Response.json({ error: { status: 'NOT_FOUND' } }, { status: 404 });
      }
      if (path.includes('/files/')) { trace.push(`capability:${role}`); return Response.json({ id: documentId, capabilities: { canEdit: !readOnly } }); }
      if (options.method === 'GET') {
        trace.push(`read:${role}`);
        if (quota && role === 'primary') return Response.json({ error: { errors: [{ reason: 'rateLimitExceeded' }] } }, { status: 403 });
        return Response.json({ documentId, content, revisionId: readOnly ? undefined : `${role}-${revision}` });
      }
      trace.push(`write:${role}`);
      assert.equal(JSON.parse(options.body).writeControl.requiredRevisionId, `${role}-${revision}`);
      if (applied) { content = 'progress'; revision++; }
      if (lostResponse) throw new Error('response lost');
      return Response.json({ documentId });
    } }),
  ]));
  const services = {
    accounts,
    verifySource() { if (rejectSource) throw new Error('DOC_IDENTITY_MISMATCH'); },
    loadCurrentProjection: () => ({ text: 'progress', reconciliation }),
    assertWriter: () => { trace.push('lease'); },
    plan: d => ({ revisionId: d.revisionId, requests: [{ insertText: { location: { tabId: position, index: 1 }, text: 'progress' } }] }),
    verify: (d, p) => d.content === p.text,
    withDocumentLock: async (id, fn) => { assert.equal(id, documentId); return fn(); },
    recordAttempt: attempt => { trace.push(`record:${attempt.accountRole}`); },
  };
  return { run: overrides => executeDocsWrite(input, { ...services, ...overrides }), trace, revision: () => revision,
    wrongTab: () => { position = 'wrong'; }, wrongSource: () => { rejectSource = true; },
    resume: accountRole => { reconciliation = { accountRole }; } };
}

test('reader fallback obtains a fresh account revision and replay performs zero writes', async () => {
  const f = fixture({ reader: true });
  const result = await f.run();
  assert.equal(result.outcome, 'applied');
  assert.equal(result.accountRole, 'fallback');
  assert.deepEqual(f.trace, ['read:primary', 'capability:primary', 'read:fallback', 'lease', 'record:fallback', 'write:fallback', 'read:fallback']);
  const next = await f.run();
  assert.equal(next.outcome, 'already_current');
  assert.equal(next.writes, 0);
  assert.equal(f.revision(), 2);
});

test('fallback without edit access leaves the job unacknowledged and sends no write', async () => {
  for (const options of [{ fallbackReader: true }, { fallbackMissing: true }]) {
    const f = fixture({ reader: true, ...options });
    await assert.rejects(f.run(), { code: 'DOC_NO_WRITABLE_ACCOUNT' });
    assert.deepEqual(f.trace, ['read:primary', 'capability:primary', 'read:fallback', 'capability:fallback']);
    assert.equal(f.revision(), 1);
  }
});

test('quota stays on primary and invalid source or tab is rejected before writing', async () => {
  const quota = fixture({ quota: true });
  await assert.rejects(quota.run(), { code: 'DOC_HTTP_403', reason: 'rateLimitExceeded' });
  assert.deepEqual(quota.trace, ['read:primary']);
  const f = fixture();
  f.wrongTab();
  await assert.rejects(f.run(), { code: 'DOC_REQUEST_SCOPE_MISMATCH' });
  assert.deepEqual(f.trace, ['read:primary']);
  f.wrongSource();
  await assert.rejects(f.run(), { message: 'DOC_IDENTITY_MISMATCH' });
  assert.deepEqual(f.trace, ['read:primary']);
});

test('lost response reads through the same account and keeps unproved attempts for reconciliation', async () => {
  const done = fixture({ reader: true, lostResponse: true });
  assert.equal((await done.run()).outcome, 'applied');
  assert.deepEqual(done.trace.slice(-2), ['write:fallback', 'read:fallback']);
  const unproved = fixture({ reader: true, lostResponse: true, applied: false });
  assert.equal((await unproved.run()).outcome, 'needs_reconciliation');
  unproved.resume('fallback');
  const replay = await unproved.run();
  assert.equal(replay.writes, 0);
  assert.equal(replay.outcome, 'needs_reconciliation');
  assert.equal(unproved.trace.at(-1), 'read:fallback');
});

test('401 refreshes only the rejected token and concurrent callers share the new grant', async () => {
  let grants = 0;
  const getToken = createGoogleDocsTokenProvider({
    credentials: { clientId: 'test', clientSecret: 'test', refreshToken: 'test' },
    fetcher: async () => Response.json({ access_token: `grant-${++grants}`, expires_in: 3600 }),
  });
  const fetcher = async (url, options) => {
    const token = options.headers.authorization;
    if (url.includes('/about')) return Response.json({ user: { emailAddress: docsAccountEmails.primary } });
    if (token === 'Bearer grant-1') return new Response(null, { status: 401 });
    assert.equal(token, 'Bearer grant-2');
    return Response.json({ documentId: new URL(url).pathname.split('/').at(-1) });
  };
  const account = createGoogleDocsAccount({ role: 'primary', getToken, fetcher });
  const count = () => {};
  await account.ensureIdentity(count);
  const result = await Promise.all(['target-one', 'target-two'].map(id => account.read(id, count)));
  assert.deepEqual(result.map(d => d.documentId), ['target-one', 'target-two']);
  assert.equal(grants, 2);
});

test('a caller request budget can reject a write before sending it', async () => {
  const blocked = Object.assign(new Error('GOOGLE_RATE_LIMITED'), { retryAtMs: 60_000 });
  const account = createGoogleDocsAccount({
    role: 'primary',
    getToken: async () => 'fixture',
    beforeRequest(operation) {
      assert.equal(operation, 'write');
      throw blocked;
    },
    fetcher: async () => assert.fail('budget rejection must never reach Google'),
  });
  await assert.rejects(account.write('target-one', { revisionId: 'v1', requests: [] }, () => {}), error => {
    assert.equal(error, blocked);
    assert.equal(error.uncertain, undefined);
    return true;
  });
});

test('logs a safe Writing error and its phase before any Google write', async () => {
  const f = fixture();
  const records = [];
  const reason = Object.assign(new Error('learner information stays private'), { code: 'LESSON4_PROGRESS_CHANGED' });
  await assert.rejects(f.run({
    assertWriter() { throw reason; },
    log: event => records.push(event),
  }), error => error === reason);
  assert.equal(records.length, 1);
  assert.equal(records[0].reason, 'LESSON4_PROGRESS_CHANGED');
  assert.equal(records[0].failurePhase, 'assert_writer');
  assert.equal(records[0].googleCalls.write, 0);
  assert.ok(!JSON.stringify(records).includes(reason.message));
  assert.deepEqual(f.trace, ['read:primary']);
});
