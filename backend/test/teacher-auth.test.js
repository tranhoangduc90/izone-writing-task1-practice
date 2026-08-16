import assert from 'node:assert/strict';
import test from 'node:test';

import { createTeacherAuthMiddleware } from '../src/teacher-auth.js';

const payload = { email: 'teacher@example.invalid', sub: 'google-subject', email_verified: true };
const config = { googleClientId: 'public-client-id.apps.googleusercontent.com' };

async function authorize(account) {
  const pool = { query: async () => ({ rowCount: account ? 1 : 0, rows: account ? [account] : [] }) };
  const middleware = createTeacherAuthMiddleware({ config, pool, verifyGoogleToken: async () => payload });
  const req = { get: (name) => name === 'authorization' ? 'Bearer valid-google-id-token' : '' };
  let status = 200;
  let body = null;
  let nextCalled = false;
  const res = { status(value) { status = value; return this; }, json(value) { body = value; return this; } };
  await middleware(req, res, () => { nextCalled = true; });
  return { req, status, body, nextCalled };
}

test('mọi tài khoản teacher active được xác thực để xem dashboard', async () => {
  const result = await authorize({ email: payload.email, role: 'teacher', can_access_all_classes: false });
  assert.equal(result.nextCalled, true);
  assert.equal(result.req.reviewer.canManage, false);
});

test('admin hoặc tài khoản được cấp toàn quyền vẫn có thể quản trị', async () => {
  const admin = await authorize({ email: payload.email, role: 'admin', can_access_all_classes: false });
  const manager = await authorize({ email: payload.email, role: 'teacher', can_access_all_classes: true });
  assert.equal(admin.req.reviewer.canManage, true);
  assert.equal(manager.req.reviewer.canManage, true);
});

test('tài khoản ngoài teacher list vẫn bị từ chối', async () => {
  const result = await authorize({ email: payload.email, role: 'student', can_access_all_classes: false });
  assert.equal(result.nextCalled, false);
  assert.equal(result.status, 403);
  assert.equal(result.body.error, 'ACCESS_DENIED');
});
