import assert from 'node:assert/strict';
import test from 'node:test';
import { createLmsResultService, normalizeLmsResult } from '../src/lms-result-service.js';

const sessionRef = '00000000-0000-4000-8000-000000000001';
const lmsUrl = 'https://practice.izone.edu.vn/shared/writing-essays/00000000-0000-4000-8000-000000000002/edit?page=0';
const paragraph = text => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

function poolWithLink(value = lmsUrl) {
  return { query: async (_sql, values) => {
    assert.deepEqual(values, [sessionRef]);
    return { rowCount: 1, rows: [{ lmsUrl: value, updatedAt: '2026-08-18T01:00:00.000Z' }] };
  } };
}

test('chỉ lấy essays và loại bỏ hoàn toàn feedback/content TR-CC', () => {
  const result = normalizeLmsResult({
    content: 'KHÔNG HIỂN THỊ',
    feedback: 'KHÔNG HIỂN THỊ',
    essays: [{ id: 'one', index: 0, content: paragraph('Bản gốc'), suggestedContent: paragraph('Bản sửa'), comments: ['Nhận xét'] }]
  });
  assert.equal(result.essays.length, 1);
  assert.equal(JSON.stringify(result).includes('KHÔNG HIỂN THỊ'), false);
});

test('proxy dùng duy nhất Quick Aid chính thức và mã lấy từ link đã lưu', async () => {
  let requested;
  const fetchImpl = async (url, options) => {
    requested = { url: String(url), options };
    return new Response(JSON.stringify({ essays: [{ content: paragraph('A'), suggestedContent: paragraph('B'), comments: [] }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    });
  };
  const result = await createLmsResultService({ pool: poolWithLink(), fetchImpl }).getDraftResult({ sessionRef });
  assert.equal(requested.url, 'https://quickaid.izone.edu.vn/v1/writing-essays/00000000-0000-4000-8000-000000000002');
  assert.equal(requested.options.redirect, 'error');
  assert.equal(result.essays.length, 1);
});

test('từ chối host LMS giả trước khi gọi mạng', async () => {
  let fetched = false;
  const service = createLmsResultService({
    pool: poolWithLink('https://practice.izone.edu.vn.evil.example/shared/writing-essays/bad/edit'),
    fetchImpl: async () => { fetched = true; }
  });
  await assert.rejects(service.getDraftResult({ sessionRef }), error => error.code === 'LMS_URL_INVALID');
  assert.equal(fetched, false);
});

test('lọc node, mark và thuộc tính không cần thiết khỏi ProseMirror', () => {
  const result = normalizeLmsResult({ essays: [{
    content: { type: 'doc', content: [{ type: 'paragraph', attrs: { onclick: 'bad' }, content: [{ type: 'text', text: 'Giữ', marks: [{ type: 'link', attrs: { href: 'javascript:bad' } }, { type: 'highlight' }] }, { type: 'image', attrs: { src: 'bad' } }] }] },
    suggestedContent: paragraph('Sửa'),
    comments: []
  }] });
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('onclick'), false);
  assert.equal(serialized.includes('javascript:'), false);
  assert.equal(serialized.includes('image'), false);
  assert.equal(serialized.includes('highlight'), true);
});
