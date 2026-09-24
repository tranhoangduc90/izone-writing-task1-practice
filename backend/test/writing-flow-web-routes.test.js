import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';
import { ApiError } from '../src/service.js';

const token = 'w'.repeat(32);
const base = '/api/v1/internal/writing-flow/web-substitute';
const identity = { testSlug: 'substitute-test-2-k56', classId: 1252,
  studentName: 'Học viên thử' };
const attemptId = '11111111-1111-4111-8111-111111111111';

function app(writingFlowWebIntake = null) {
  return createApp({
    config: { trustProxyHops: 0, allowedOrigins: new Set(),
      internalApiToken: 'i'.repeat(32), webSubstituteApiToken: token },
    pool: { query: async () => ({ rows: [] }) },
    service: {}, writingFlowWebIntake,
  });
}

// Dữ liệu vào: yêu cầu gateway giả; không gửi bài hoặc thông tin học viên thật.
// Việc chính: kiểm Bearer, schema, 503 khi chưa cấu hình và 202 sau phiếu nhận.
// Kết quả: client không thể nhận trạng thái đã nộp từ route chưa lưu bền.
// Khi lỗi: response chỉ có mã lỗi/truy vết, không in bài Writing.
test('route Substitute đóng nếu thiếu khóa nội bộ hoặc adapter', async () => {
  const missing = await request(app()).post(`${base}/attempts`).send(identity);
  assert.equal(missing.status, 401);
  const oldInternalToken = await request(app()).post(`${base}/attempts`)
    .set('Authorization', `Bearer ${'i'.repeat(32)}`).send(identity);
  assert.equal(oldInternalToken.status, 401);
  const unavailable = await request(app()).post(`${base}/attempts`)
    .set('Authorization', `Bearer ${token}`).send(identity);
  assert.equal(unavailable.status, 503);
  assert.equal(unavailable.body.error, 'WEB_INTAKE_NOT_READY');
});

test('route chỉ trả 202 sau biên nhận có đọc lại từ service', async () => {
  const calls = [];
  const candidate = app({
    openAttempt: async input => {
      calls.push({ action: 'open', input });
      return { attemptId, status: 'open', taskNumber: 1 };
    },
    submitWriting: async input => {
      calls.push({ action: 'submit', input });
      return { submissionId: '22222222-2222-4222-8222-222222222222',
        attemptId, taskNumber: 1, status: 'pending' };
    },
    getStatus: async input => {
      calls.push({ action: 'status', input });
      return { attemptId, submissionStatus: 'pending', result: null };
    },
  });
  const open = await request(candidate).post(`${base}/attempts`)
    .set('Authorization', `Bearer ${token}`).send(identity);
  assert.equal(open.status, 200);
  assert.equal(open.body.attempt.attemptId, attemptId);
  const submission = { ...identity, attemptId, taskNumber: 1,
    essay: 'Synthetic response.' };
  const receipt = await request(candidate).post(`${base}/submissions`)
    .set('Authorization', `Bearer ${token}`).send(submission);
  assert.equal(receipt.status, 202);
  assert.equal(receipt.body.receipt.status, 'pending');
  assert.equal(Object.hasOwn(receipt.body.receipt, 'runKey'), false);
  const status = await request(candidate).post(`${base}/status`)
    .set('Authorization', `Bearer ${token}`).send({ ...identity, attemptId });
  assert.equal(status.status, 200);
  assert.equal(status.body.status.submissionStatus, 'pending');
  assert.deepEqual(calls.map(row => row.action), ['open', 'submit', 'status']);
  const invalid = await request(candidate).post(`${base}/submissions`)
    .set('Authorization', `Bearer ${token}`).send({ ...submission, taskNumber: 3 });
  assert.equal(invalid.status, 400);
  assert.equal(calls.length, 3);
});

test('lỗi đọc lại sau ghi không bị route đổi thành accepted', async () => {
  const candidate = app({
    openAttempt: async () => ({ attemptId }),
    submitWriting: async () => { throw new ApiError(503,
      'WEB_RECEIPT_READBACK_UNKNOWN', 'Chưa xác nhận được phiếu nhận bài.'); },
  });
  const response = await request(candidate).post(`${base}/submissions`)
    .set('Authorization', `Bearer ${token}`)
    .send({ ...identity, attemptId, taskNumber: 1, essay: 'Synthetic response.' });
  assert.equal(response.status, 503);
  assert.equal(response.body.error, 'WEB_RECEIPT_READBACK_UNKNOWN');
  assert.equal(JSON.stringify(response.body).includes('Synthetic response.'), false);
});
