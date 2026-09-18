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

function makeApp(role, overrides = {}, stageOverrides = {}, aiOverrides = {}, scanOverrides = {}) {
  const service = {
    listPairs: async () => [{ pair_id: reviewId, status: 'needs_review' }],
    listReviews: async () => [{ review_id: reviewId, status: 'open' }],
    listSourceIssues: async () => [{ issue_key: 'a'.repeat(64), reason_code: 'FETCH_FAILED' }],
    recordSourceIssue: async input => ({ issue_key: 'a'.repeat(64), reason_code: input.reasonCode }),
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
    writingFlowHandoff: {
      due: async limit => [{ handoffId: reviewId, stageKey: 'main', sendCount: limit }],
      recoverExpired: async () => [],
    },
    writingFlowAiCall: {
      start: async input => ({ status: 'sent', operationKey: `writing:${input.attemptId}:0` }),
      finish: async () => ({ status: 'succeeded' }),
      ...aiOverrides,
    },
    writingFlowScan: {
      cursor: async () => ({ scannedThroughAt: null }),
      begin: async input => ({ runId: reviewId, count: input.items.length }),
      prepare: async input => ({ itemKey: input.itemKey, status: 'planned',
        operationCount: input.receiptRequest.expectedPairs.length
          + input.receiptRequest.expectedIssues.length }),
      acknowledge: async input => ({ itemKey: input.itemKey, status: input.status }),
      finish: async () => ({ runId: reviewId, status: 'complete' }),
      due: async () => [],
      finishReady: async () => ({ scans: [], failureCount: 0, failures: [] }),
      receipts: async () => ({ pairIds: [reviewId], issueKeys: [] }),
      closureEligibility: async () => ({ eligible: false, reason: 'PAIR_NOT_DELIVERED' }),
      dueClosures: async () => [{ runId: reviewId, recordId: 'record-demo' }],
      completeClosure: async () => ({ status: 'done', runId: reviewId,
        recordId: 'record-demo' }),
      ...scanOverrides,
    },
    adminAuth: (req, res, next) => {
      if (!role) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
      req.reviewer = { role, email: 'teacher@example.invalid' };
      return next();
    },
  });
}

test('kế hoạch từng ô phải lưu qua token nội bộ trước khi phát không chờ', async () => {
  const url = '/api/v1/internal/writing-flow/scans/prepare';
  const body = { runId: reviewId, itemKey: 'a'.repeat(64), status: 'partial',
    detectedSlotCount: 2, receiptRequest: { appId: 'app-demo',
      tableId: 'table-demo', recordId: 'record-demo', docId: 'doc-demo',
      linkIndex: 2, expectedPairs: [{ essaySlot: 1, revision: 'b'.repeat(64) }],
      expectedIssues: [{ essaySlot: 2, reasonCode: 'SOURCE_MISSING' }] } };
  assert.equal((await request(makeApp(null)).post(url).send(body)).status, 401);
  const bad = await request(makeApp(null)).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`)
    .send({ ...body, receiptRequest: { ...body.receiptRequest,
      expectedPairs: [{ essaySlot: 2, revision: 'b'.repeat(64) }] } });
  assert.equal(bad.status, 400);
  const accepted = await request(makeApp(null)).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`).send(body);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.item.operationCount, 2);
});

test('lượt quét cần token và danh sách đã đọc hết trang', async () => {
  const url = '/api/v1/internal/writing-flow/scans/begin';
  const body = { requestKey: requestId, appId: 'app-demo', tableId: 'table-demo',
    scannedThroughAt: '2026-09-17T08:00:00Z', pageCount: 1,
    reachedEnd: true, items: [{ recordId: 'record-demo', docId: 'doc-demo',
      linkIndex: 2, classCode: 'IC2200' }] };
  assert.equal((await request(makeApp(null)).post(url).send(body)).status, 401);
  const bad = await request(makeApp(null)).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`)
    .send({ ...body, reachedEnd: false });
  assert.equal(bad.status, 400);
  const accepted = await request(makeApp(null)).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`).send(body);
  assert.equal(accepted.status, 201);
  assert.equal(accepted.body.scan.count, 1);
});

test('chốt mốc quét trả trạng thái một phần và không che link lỗi', async () => {
  const url = '/api/v1/internal/writing-flow/scans/finish-ready';
  const app = makeApp(null, {}, {}, {}, { finishReady: async () => ({
    scans: [{ runId: reviewId, status: 'complete' }], failureCount: 1,
    failures: [{ runId: requestId, itemKey: 'a'.repeat(64),
      step: 'receipt', code: '08006' }],
  }) });
  const response = await request(app).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`)
    .send({ limit: 10 });
  assert.equal(response.status, 207);
  assert.equal(response.body.ok, false);
  assert.equal(response.body.outcome, 'partial');
  assert.equal(response.body.scans[0].runId, reviewId);
  assert.equal(response.body.failures[0].code, '08006');
});

test('đọc lại biên nhận từng ô chỉ dùng token nội bộ', async () => {
  const url = '/api/v1/internal/writing-flow/scans/receipts';
  const body = { appId: 'app-demo', tableId: 'table-demo',
    recordId: 'record-demo', docId: 'doc-demo', linkIndex: 2,
    expectedPairs: [{ essaySlot: 1, revision: 'a'.repeat(64) }],
    expectedIssues: [] };
  assert.equal((await request(makeApp(null)).post(url).send(body)).status, 401);
  const accepted = await request(makeApp(null)).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`).send(body);
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body.receipts.pairIds, [reviewId]);
  const duplicate = await request(makeApp(null)).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`)
    .send({ ...body, expectedIssues: [{ essaySlot: 1, reasonCode: 'PARSER_FAILED' }] });
  assert.equal(duplicate.status, 400);
});

test('điều kiện chốt hồ sơ chỉ đọc được bằng token nội bộ', async () => {
  const url = '/api/v1/internal/writing-flow/scans/closure-eligibility';
  const body = { appId: 'app-demo', tableId: 'table-demo', recordId: 'record-demo' };
  assert.equal((await request(makeApp(null)).post(url).send(body)).status, 401);
  const result = await request(makeApp(null)).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`).send(body);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.closure,
    { eligible: false, reason: 'PAIR_NOT_DELIVERED' });
});

test('hàng chốt hồ sơ và biên nhận chốt chỉ dùng token nội bộ', async () => {
  const dueUrl = '/api/v1/internal/writing-flow/scans/closure-due';
  assert.equal((await request(makeApp(null)).post(dueUrl).send({ limit: 10 })).status, 401);
  const due = await request(makeApp(null)).post(dueUrl)
    .set('Authorization', `Bearer ${config.internalApiToken}`).send({ limit: 10 });
  assert.equal(due.status, 200);
  assert.equal(due.body.records[0].recordId, 'record-demo');
  const completeUrl = '/api/v1/internal/writing-flow/scans/closure-complete';
  const body = { runId: reviewId, appId: 'app-demo', tableId: 'table-demo',
    recordId: 'record-demo', finishedAtMs: 1780000000000 };
  assert.equal((await request(makeApp(null)).post(completeUrl).send(body)).status, 401);
  const complete = await request(makeApp(null)).post(completeUrl)
    .set('Authorization', `Bearer ${config.internalApiToken}`).send(body);
  assert.equal(complete.status, 200);
  assert.equal(complete.body.closure.status, 'done');
});

test('chỉ quản trị viên thấy danh sách bài cần kiểm tra', async () => {
  assert.equal((await request(makeApp(null)).get('/api/v1/admin/writing-flow/reviews')).status, 401);
  assert.equal((await request(makeApp('teacher')).get('/api/v1/admin/writing-flow/reviews')).status, 403);
  const response = await request(makeApp('admin')).get('/api/v1/admin/writing-flow/reviews');
  assert.equal(response.status, 200);
  assert.equal(response.body.reviews[0].review_id, reviewId);
});

test('lỗi nguồn có danh sách riêng và route ghi chỉ dùng token nội bộ', async () => {
  assert.equal((await request(makeApp('teacher')).get('/api/v1/admin/writing-flow/source-issues')).status, 403);
  const listed = await request(makeApp('admin')).get('/api/v1/admin/writing-flow/source-issues');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.issues[0].reason_code, 'FETCH_FAILED');
  const url = '/api/v1/internal/writing-flow/source-issues';
  assert.equal((await request(makeApp(null)).post(url).send({})).status, 401);
  const recorded = await request(makeApp(null)).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`)
    .send({ appId: 'app-demo', tableId: 'table-demo',
      recordId: 'record-demo', docId: 'doc-demo', linkIndex: 2,
      classCode: 'IC2200', reasonCode: 'FETCH_FAILED' });
  assert.equal(recorded.status, 202);
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
    operationKey: 'scan-demo', appId: 'app-demo', tableId: 'table-demo',
    recordId: 'record-demo', docId: 'doc-demo',
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

test('bàn giao và cứu bước quá hạn chỉ mở bằng token nội bộ', async () => {
  const app = makeApp(null);
  const dueUrl = '/api/v1/internal/writing-flow/handoffs/due';
  const recoverUrl = '/api/v1/internal/writing-flow/handoffs/recover';
  assert.equal((await request(app).post(dueUrl).send({})).status, 401);
  const due = await request(app).post(dueUrl)
    .set('Authorization', `Bearer ${config.internalApiToken}`).send({ limit: 5 });
  assert.equal(due.status, 200);
  assert.equal(due.body.handoffs[0].sendCount, 5);
  assert.equal((await request(app).post(recoverUrl)
    .set('Authorization', `Bearer ${config.internalApiToken}`).send({})).status, 200);
});

test('ghi lần gọi AI chỉ nhận lượt chấm hợp lệ qua token nội bộ', async () => {
  let received;
  const app = makeApp(null, {}, {}, { start: async input => {
    received = input;
    return { status: 'sent', operationKey: 'writing:demo:0' };
  } });
  const url = '/api/v1/internal/writing-flow/ai-calls/start';
  const body = { pairId: reviewId, revision: 'a'.repeat(64), stageKey: 'main',
    attemptId: requestId, batchIndex: 0, prompt: 'Đề và bài giả lập' };
  assert.equal((await request(app).post(url).send(body)).status, 401);
  const accepted = await request(app).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`).send(body);
  assert.equal(accepted.status, 200);
  assert.equal(received.pairId, reviewId);
  assert.equal(received.prompt, 'Đề và bài giả lập');
  assert.equal((await request(app).post(url)
    .set('Authorization', `Bearer ${config.internalApiToken}`)
    .send({ ...body, stageKey: 'deliver' })).status, 400);
});
