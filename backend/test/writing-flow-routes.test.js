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

function makeApp(role, overrides = {}) {
  const service = {
    listPairs: async () => [{ pair_id: reviewId, status: 'needs_review' }],
    listReviews: async () => [{ review_id: reviewId, status: 'open' }],
    requestRetry: async input => ({ reviewId: input.reviewId, status: 'retry_requested' }),
    ...overrides,
  };
  return createApp({
    config,
    pool: { query: async () => ({ rows: [] }) },
    service: {},
    writingFlowService: service,
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
