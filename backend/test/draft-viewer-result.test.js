// API giả kiểm đường đọc kết quả cũ/mới, lỗi mạng và giữ đúng phiên; không ghi database.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLmsResultService } from '../src/lms-result-service.js';

const id = 'a'.repeat(48);
const viewer = `https://ducizone.ddns.net/writing/shared/writing-essays/${id}/edit`;
const doc = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
const payload = { essays: [{ id: 'fake-sentence', index: 0, content: doc('Original.'), suggestedContent: doc('Corrected.'), comments: ['Giải thích giả.'] }] };
const pool = link => ({ query: async (_sql, values) => {
  assert.deepEqual(values, ['fake-session']);
  return { rowCount: 1, rows: [{ lmsUrl: link, updatedAt: '2026-09-20T04:00:00Z' }] };
} });
const response = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('Draft viewer trả đủ câu gốc, câu sửa và giải thích từ snapshot mới', async () => {
  let calls = 0;
  const svc = createLmsResultService({ pool: pool(viewer), fetchImpl: async (url, options) => {
    calls++;
    assert.equal(String(url), `https://ducizone.ddns.net/writing/writing-data/${id}/current.json`);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.cache, 'no-store');
    return response({ ...payload, meta: { updatedAt: '2026-09-21T01:00:00Z' } });
  } });
  const result = await svc.getDraftResult({ sessionRef: 'fake-session' });
  assert.deepEqual(result.essays, payload.essays);
  assert.equal(result.updatedAt, '2026-09-21T01:00:00.000Z');
  assert.equal(calls, 1);
});

test('Draft cũ vẫn đọc đúng QuickAid và giữ thời điểm hoàn tất', async () => {
  const svc = createLmsResultService({ pool: pool('https://practice.izone.edu.vn/shared/writing-essays/legacy-id/edit?page=0'), fetchImpl: async url => {
    assert.equal(String(url), 'https://quickaid.izone.edu.vn/v1/writing-essays/legacy-id');
    return response(payload);
  } });
  assert.equal((await svc.getDraftResult({ sessionRef: 'fake-session' })).updatedAt, '2026-09-20T04:00:00Z');
});

test('Draft từ chối URL ngoài hợp đồng trước mọi kết nối', async () => {
  for (const link of [viewer + '?v=2', viewer + '#x', viewer.replace('/edit', '/view?v=2'),
    viewer.replace('https://', 'https://user:password@'), viewer.replace('.net/', '.net:444/'),
    viewer.replace('ducizone.ddns.net', 'ducizone.ddns.net.evil.example'),
    'https://user:password@practice.izone.edu.vn/shared/writing-essays/legacy-id/edit']) {
    let fetched = false;
    const svc = createLmsResultService({ pool: pool(link), fetchImpl: async () => { fetched = true; } });
    await assert.rejects(svc.getDraftResult({ sessionRef: 'fake-session' }), e => e.code === 'LMS_URL_INVALID');
    assert.equal(fetched, false);
  }
});

test('Snapshot rỗng hợp lệ không biến thành lỗi chấm', async () => {
  const result = await createLmsResultService({ pool: pool(viewer), fetchImpl: async () => response({ essays: [] }) }).getDraftResult({ sessionRef: 'fake-session' });
  assert.deepEqual(result.essays, []);
});

test('Lỗi tải hoặc payload sai không báo thành công và lần đọc sau có thể phục hồi', async () => {
  for (const [fetchImpl, code] of [
    [async () => new Response('', { status: 404 }), 'LMS_UNAVAILABLE'],
    [async () => new Response('bad json'), 'LMS_RESULT_INVALID'],
    [async () => response({ wrong: [] }), 'LMS_RESULT_INVALID'],
    [async () => new Response('{}', { headers: { 'content-length': String(5 * 1024 * 1024) } }), 'LMS_RESULT_TOO_LARGE'],
    [async (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(Error('aborted')))), 'LMS_UNAVAILABLE'],
  ]) {
    let failedOnce = false;
    const svc = createLmsResultService({ pool: pool(viewer), timeoutMs: 10, fetchImpl: async (...args) => {
      if (!failedOnce) { failedOnce = true; return fetchImpl(...args); }
      return response(payload);
    } });
    await assert.rejects(svc.getDraftResult({ sessionRef: 'fake-session' }), e => e.code === code);
    assert.deepEqual((await svc.getDraftResult({ sessionRef: 'fake-session' })).essays, payload.essays);
  }
});

test('Hai phiên đọc đồng thời không lấy nhầm snapshot của nhau', async () => {
  const svc = createLmsResultService({
    pool: { query: async (_sql, [sessionRef]) => ({ rowCount: 1, rows: [{ lmsUrl: viewer.replace(id, sessionRef.repeat(48)) }] }) },
    fetchImpl: async url => { const marker = String(url).split('/').at(-2); return response({ essays: [{ ...payload.essays[0], id: marker }] }); },
  });
  const results = await Promise.all(['a', 'b'].map(sessionRef => svc.getDraftResult({ sessionRef })));
  assert.deepEqual(results.map(x => x.essays[0].id), [id, 'b'.repeat(48)]);
});
