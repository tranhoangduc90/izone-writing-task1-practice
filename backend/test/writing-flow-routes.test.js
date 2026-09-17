import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

const reviewId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const config = {
  trustProxyHops: 0,
  allowedOrigins: new Set(['https://app.example.invalid']),
  internalApiToken: 'i'.repeat(32),
  adminApiToken: 'a'.repeat(32),
};

function makeApp(role, overrides = {}, stageOverrides = {}) {
  const service = {
    listPairs: async () => [{ pair_id: reviewId, status: 'needs_review' }],
    listReviews: async () => [{ review_id: reviewId, status: 'open' }],
    requestRetry: async input => ({ reviewId: input.reviewId, status: 'retry_requested' }),
    intakePairs: async () => ({ detectedCount: 1, registeredCount: 1, receipts: [] }),
    ...overrides,
  };
  return createApp({
    config,
    pool: { query: async () => ({ rows: [] }) },
    service: {},
    writingFlowService: service,
    writingFlowStage: {
      claim: async () => ({ status: 'started' }),
      complete: async () => ({ status: 'succeeded' }),
      fail: async () => ({ status: 'retry_requested' }),
      ...stageOverrides,
    },
    adminAuth: (req, res, next) => {
      if (!role) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      req.reviewer = { role, email: 'teacher@example.invalid' };
      return next();
    },
  });
}

test('chỉ quản trị viên thấy danh sách bài cần kiểm tra', async () => {
  assert.equal((await request(makeApp(null)).get('/api/v1/admin/writing-flow/reviews')).status, 401);
  assert.equal((await request(makeApp('teacher')).get('/api/v1/admin/writing-flow/reviews')).status, 403);
  const response = await request(makeApp('admin')).get('/api/v1/admin/writing-flow/reviews');
  assert.equal(response.status, 200);
  assert.equal(response.body.reviews[0].review_id, reviewId);
});

test('nút chạy lại gửi mã yêu cầu tới dịch vụ, không tuyên bố bài đã chấm xong', async () => {
  let received;
  const app = makeApp('admin', { requestRetry: async input => {
    received = input;
    return { reviewId: input.reviewId, status: 'retry_requested' };
  } });
  const response = await request(app)
    .post(`/api/v1/admin/writing-flow/reviews/${reviewId}/retry`)
    .send({ requestId });
  assert.equal(response.status, 202);
  assert.equal(response.body.review.status, 'retry_requested');
  assert.equal(received.requestId, requestId);
  assert.equal(received.actorRef, 'teacher@example.invalid');
  assert.equal((await request(app)
    .post(`/api/v1/admin/writing-flow/reviews/${reviewId}/retry`)
    .send({ requestId: 'not-a-uuid' })).status, 400);
});

test('tiếp nhận từng cặp bắt buộc token nội bộ và identity của file', async () => {
  const url = '/api/v1/internal/writing-flow/intake';
  assert.equal((await request(makeApp('admin')).post(url).send({})).status, 401);
  const body = {
    operationKey: 'scan-demo', recordId: 'record-demo', docId: 'doc-demo',
    linkIndex: 2, classCode: 'IC2200', sourceModifiedAt: '2026-09-17T08:00:00.000Z',
    larkMeta: { classCode: 'IC2200', imageUrls: {
      1: '', 2: '', 3: '', 4: 'https://example.test/chart-four',
    } },
    documentKind: 'google_docs', verifiedMime: 'application/vnd.google-apps.document',
    expectedCount: 1, pairs: [{ essaySlot: 4, taskType: 'task_1',
      topic: 'Đề giả', image: 'https://example.test/chart-four', essay: 'Bài giả' }],
  };
  const accepted = await request(makeApp(null)).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`).send(body);
  assert.equal(accepted.status, 202);
  assert.equal(accepted.body.receipt.registeredCount, 1);
  const invalid = await request(makeApp(null)).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`)
    .send({ ...body, linkIndex: 0 });
  assert.equal(invalid.status, 400);
});

test('giai đoạn chỉ chạy qua API nội bộ và mang đúng cặp, phiên bản, bàn giao', async () => {
  let received;
  const app = makeApp(null, {}, { claim: async input => {
    received = input;
    return { status: 'started' };
  } });
  const url = '/api/v1/internal/writing-flow/stages/claim';
  const body = { pairId: reviewId, revision: 'a'.repeat(64), stageKey: 'critic',
    handoffId: requestId, executionId: 'execution-demo' };
  assert.equal((await request(app).post(url).send(body)).status, 401);
  const accepted = await request(app).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`).send(body);
  assert.equal(accepted.status, 200);
  assert.equal(received.stageKey, 'critic');
  assert.equal(received.handoffId, requestId);
  const invalid = await request(app).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`)
    .send({ ...body, stageKey: 'unknown' });
  assert.equal(invalid.status, 400);
});
