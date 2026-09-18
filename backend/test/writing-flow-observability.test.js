import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { writingFlowRequestLog } from '../src/writing-flow-observability.js';

test('nhật ký ghi mã bài và lỗi nhưng không ghi bài viết, prompt hoặc token', () => {
  const lines = [];
  const middleware = writingFlowRequestLog({ write: line => lines.push(line), now: () => 1200 });
  const req = { method: 'POST', path: '/api/v1/internal/writing-flow/stages/fail',
    route: { path: '/api/v1/internal/writing-flow/stages/fail' },
    body: { pairId: '11111111-1111-4111-8111-111111111111',
      attemptId: '22222222-2222-4222-8222-222222222222', stageKey: 'main',
      executionId: '12345', errorCode: 'AI_TIMEOUT',
      essay: 'NỘI DUNG RIÊNG', prompt: 'PROMPT BÍ MẬT', token: 'TOKEN BÍ MẬT' } };
  const res = Object.assign(new EventEmitter(), { statusCode: 409, locals: {},
    set(name, value) { this.headers ??= {}; this.headers[name] = value; } });
  let nextCalled = false;
  middleware(req, res, () => { nextCalled = true; });
  res.locals.writingErrorCode = 'ATTEMPT_CONFLICT';
  res.emit('finish');
  assert.equal(nextCalled, true);
  assert.match(res.headers['X-Writing-Request-Id'], /^[0-9a-f-]{36}$/);
  assert.equal(lines.length, 1);
  const row = JSON.parse(lines[0]);
  assert.equal(row.pairId, '11111111-1111-4111-8111-111111111111');
  assert.equal(row.attemptId, '22222222-2222-4222-8222-222222222222');
  assert.equal(row.executionId, '12345');
  assert.equal(row.errorCode, 'ATTEMPT_CONFLICT');
  assert.equal(row.status, 409);
  assert.equal(lines[0].includes('NỘI DUNG RIÊNG'), false);
  assert.equal(lines[0].includes('PROMPT BÍ MẬT'), false);
  assert.equal(lines[0].includes('TOKEN BÍ MẬT'), false);
});

test('không lấy chuỗi tự do trong request làm định danh đưa vào log', () => {
  const lines = [];
  const middleware = writingFlowRequestLog({ write: line => lines.push(line) });
  const res = Object.assign(new EventEmitter(), { statusCode: 400, locals: {}, set() {} });
  middleware({ method: 'POST', path: '/api/v1/internal/writing-flow/stages/fail',
    body: { pairId: 'Tên học viên', executionId: 'bài viết riêng tư',
      errorCode: 'lỗi: có nội dung bài' } }, res, () => {});
  res.emit('finish');
  const row = JSON.parse(lines[0]);
  assert.equal(row.pairId, undefined);
  assert.equal(row.executionId, undefined);
  assert.equal(row.errorCode, undefined);
});

test('lỗi ở node khởi động giữ mã sự kiện khi n8n chưa có execution gốc', () => {
  const lines = [];
  const middleware = writingFlowRequestLog({ write: line => lines.push(line) });
  const res = Object.assign(new EventEmitter(), { statusCode: 202, locals: {}, set() {} });
  middleware({ method: 'POST', path: '/api/v1/internal/writing-flow/workflow-failures',
    body: { executionId: 'trigger-1654609328787' } }, res, () => {});
  res.emit('finish');
  assert.equal(JSON.parse(lines[0]).executionId, 'trigger-1654609328787');
});

test('lỗi ghi log không chặn phản hồi API', () => {
  const middleware = writingFlowRequestLog({ write: () => { throw Error('log offline'); } });
  const res = Object.assign(new EventEmitter(), { statusCode: 200, locals: {}, set() {} });
  middleware({ method: 'GET', path: '/api/v1/admin/writing-flow/summary' }, res, () => {});
  assert.doesNotThrow(() => res.emit('finish'));
});
