// Nhận vào: tài khoản giảng viên giả, module xác thực của đúng bản API cần kiểm.
// Việc chính: mở/khôi phục/đăng xuất phiên, đối chiếu cookie và hạn lưu trong DB giả.
// Kết quả: cookie gần 90 ngày, hạn tuyệt đối 365 ngày và đăng xuất thu hồi phiên.
// Không gọi Google, database hay URL thật; khi lỗi test nêu thuộc tính phiên sai.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createTeacherAuthService } from '../src/teacher-auth.js';

test('phiên giảng viên production giữ 90 ngày và thu hồi khi đăng xuất', async () => {
  const calls = [];
  const account = { email: 'teacher@example.invalid', role: 'teacher',
    display_name: 'Giảng viên giả', can_access_all_classes: false };
  const expiry = () => ({ idle_expires_at: new Date(Date.now() + 90 * 86400000).toISOString(),
    absolute_expires_at: new Date(Date.now() + 365 * 86400000).toISOString() });
  const pool = { async query(sql, values) {
    calls.push({ sql, values });
    if (sql.includes('UPDATE mapping.reviewer_account')) return { rowCount: 1, rows: [account] };
    if (sql.includes('INSERT INTO mapping.reviewer_session')) return { rowCount: 1, rows: [expiry()] };
    if (sql.includes('UPDATE mapping.reviewer_session AS session')) {
      return { rowCount: 1, rows: [{ ...account, ...expiry() }] };
    }
    return { rowCount: 1, rows: [] };
  } };
  const auth = createTeacherAuthService({ pool, config: { nodeEnv: 'production',
    googleClientId: 'public-demo.apps.googleusercontent.com' },
    verifyGoogleToken: async () => ({ email: account.email, sub: 'demo-subject', email_verified: true }) });
  function response() {
    return { cookies: [], statusCode: 200,
      append(name, value) { if (name === 'Set-Cookie') this.cookies.push(value); },
      status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  }
  function checkCookie(value) {
    const maxAge = Number(value.match(/Max-Age=(\d+)/u)?.[1]);
    assert.ok(maxAge >= 89 * 86400 && maxAge <= 90 * 86400, 'Cookie giữ gần 90 ngày');
    for (const part of ['HttpOnly', 'Secure', 'SameSite=None', 'Partitioned', 'Path=/writing-api']) {
      assert.ok(value.includes(part), `Cookie có ${part}`);
    }
  }
  const login = response();
  await auth.login({ body: { credential: 'google-credential-demo-long-enough' } }, login);
  assert.equal(login.statusCode, 201);
  checkCookie(login.cookies[0]);
  const insert = calls.find(call => call.sql.includes('INSERT INTO mapping.reviewer_session'));
  assert.deepEqual(insert.values.slice(3), [90, 365]);
  const cookie = login.cookies[0].split(';')[0];
  const req = { method: 'GET', get: name => name === 'cookie' ? cookie : '' };
  const restored = response();
  let accepted = false;
  await auth.authenticate(req, restored, () => { accepted = true; });
  assert.equal(accepted, true);
  checkCookie(restored.cookies[0]);
  const refresh = calls.find(call => call.sql.includes('UPDATE mapping.reviewer_session AS session'));
  assert.equal(refresh.values[1], 90);
  const logout = response();
  await auth.logout(req, logout);
  assert.ok(calls.some(call => call.sql.includes("revoked_reason, 'logout'")));
  assert.match(logout.cookies[0], /Max-Age=0/u);
});
