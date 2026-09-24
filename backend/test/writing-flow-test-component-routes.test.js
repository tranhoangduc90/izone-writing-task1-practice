import assert from 'node:assert/strict';
import test from 'node:test';
import request from 'supertest';
import { createApp } from '../src/app.js';

const pairId = '11111111-1111-4111-8111-111111111111';
const stageAttemptId = '22222222-2222-4222-8222-222222222222';
const runKey = '33333333-3333-4333-8333-333333333333';
const token = 't'.repeat(32);
const base = { pairId, revision: 'a'.repeat(64), stageAttemptId };
const callback = { ...base, componentCode: 'tr_position',
  inputSha256: 'b'.repeat(64), runKey };

function app(components) {
  return createApp({
    config: { trustProxyHops: 0, allowedOrigins: new Set(), internalApiToken: token },
    pool: { query: async () => ({ rows: [] }) }, service: {},
    writingTestComponents: components,
  });
}

test('API thành phần Test chỉ nhận token nội bộ và đúng định danh lượt chấm', async () => {
  const received = [];
  const target = app({
    startPhase: async value => { received.push(value); return { status: 'running', jobs: [] }; },
    complete: async value => { received.push(value); return { status: 'accepted' }; },
    fail: async value => { received.push(value); return { status: 'retry_ready' }; },
  });
  const root = '/api/v1/internal/writing-flow/test-components';
  assert.equal((await request(target).post(`${root}/start`)
    .send({ ...base, phase: 'detail',
      contractHashes: { tr_position: 'd'.repeat(64) } })).status, 401);
  assert.equal((await request(target).post(`${root}/start`)
    .set('Authorization', `Bearer ${token}`)
    .send({ ...base, phase: 'detail',
      contractHashes: { tr_position: 'd'.repeat(64) } })).status, 200);
  assert.equal(received[0].stageAttemptId, stageAttemptId);
  assert.equal((await request(target).post(`${root}/start`)
    .set('Authorization', `Bearer ${token}`)
    .send({ ...base, phase: 'detail', componentCode: 'tr_position',
      contractHashes: { tr_position: 'd'.repeat(64) } })).status, 200);
  assert.equal(received[1].componentCode, 'tr_position');
  assert.equal((await request(target).post(`${root}/start`)
    .set('Authorization', `Bearer ${token}`)
    .send({ ...base, phase: 'criterion', componentCode: 'aggregate_TA',
      contractHashes: { aggregate_TA: 'd'.repeat(64) } })).status, 200);
  assert.equal(received[2].componentCode, 'aggregate_TA');
  assert.equal((await request(target).post(`${root}/start`)
    .set('Authorization', `Bearer ${token}`)
    .send({ ...base, phase: 'criterion', componentCode: 'aggregate_BAD',
      contractHashes: { aggregate_BAD: 'd'.repeat(64) } })).status, 400);
  assert.equal((await request(target).post(`${root}/complete`)
    .set('Authorization', `Bearer ${token}`)
    .send({ ...callback, result: { feedback: 'Bài giả' } })).status, 200);
  assert.equal(received[3].runKey, runKey);
  assert.equal((await request(target).post(`${root}/fail`)
    .set('Authorization', `Bearer ${token}`)
    .send({ ...callback, errorCode: 'AI_FAILED' })).status, 200);
  assert.equal(received[4].errorCode, 'AI_FAILED');
  assert.equal((await request(target).post(`${root}/complete`)
    .set('Authorization', `Bearer ${token}`)
    .send({ ...callback, inputSha256: 'wrong', result: {} })).status, 400);
  assert.equal((await request(target).post(`${root}/fail`)
    .set('Authorization', `Bearer ${token}`)
    .send({ ...callback, errorCode: 'private failure text' })).status, 400);
  assert.equal(received.length, 5);
});
