import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import request from 'supertest';
import { createTeacherAuthService } from '../src/teacher-auth.js';

const origin = 'https://tranhoangduc90.github.io';

function fixture() {
  const calls = [];
  const pool = {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('UPDATE mapping.reviewer_account')) return { rowCount: 1, rows: [{ email: 'admin@example.invalid', display_name: 'Quản trị thử', role: 'admin', can_access_all_classes: true }] };
      if (sql.includes('INSERT INTO mapping.reviewer_session')) return { rowCount: 1, rows: [{ idle_expires_at: new Date(Date.now() + 90 * 86_400_000), absolute_expires_at: new Date(Date.now() + 365 * 86_400_000) }] };
      if (sql.includes('UPDATE mapping.reviewer_session AS session')) return { rowCount: 1, rows: [{ email: 'admin@example.invalid', display_name: 'Quản trị thử', role: 'admin', can_access_all_classes: true, idle_expires_at: new Date(Date.now() + 90 * 86_400_000), absolute_expires_at: new Date(Date.now() + 365 * 86_400_000) }] };
      return { rowCount: 1, rows: [] };
    }
  };
  const config = {
    nodeEnv: 'test', googleClientId: 'client-for-test', allowedOrigins: new Set([origin]),
    teacherSessionIdleDays: 90, teacherSessionAbsoluteDays: 365,
    teacherSessionCookieName: 'izone_teacher_session', teacherSessionCookiePath: '/writing-api',
    teacherSessionCookieSecure: false, teacherSessionCookieSameSite: 'Lax'
  };
  const auth = createTeacherAuthService({
    config,
    pool,
    verifyGoogleToken: async () => ({ email: 'admin@example.invalid', sub: 'google-subject-test', email_verified: true, name: 'Quản trị thử' })
  });
  const app = express();
  app.use(express.json());
  app.post('/api/v1/auth/session', auth.login);
  app.get('/api/v1/auth/session', auth.authenticate, (req, res) => res.json({ ok: true, reviewer: req.reviewer }));
  app.delete('/api/v1/auth/session', auth.authenticate, auth.logout);
  return { app, pool };
}

test('Writing API dùng cookie riêng theo path và vẫn kiểm CSRF khi logout', async () => {
  const { app, pool } = fixture();
  const login = await request(app).post('/api/v1/auth/session').send({ credential: 'google-credential-for-writing-test' });
  assert.equal(login.status, 201);
  assert.equal(login.body.reviewer.canManage, true);
  assert.match(login.headers['set-cookie'][0], /Path=\/writing-api/u);
  assert.equal(JSON.stringify(pool.calls).includes('google-credential-for-writing-test'), false);

  const cookie = login.headers['set-cookie'][0].split(';', 1)[0];
  const restored = await request(app).get('/api/v1/auth/session').set('Cookie', cookie);
  assert.equal(restored.status, 200);
  assert.equal(restored.body.reviewer.email, 'admin@example.invalid');

  assert.equal((await request(app).delete('/api/v1/auth/session').set('Origin', origin).set('Cookie', cookie)).status, 403);
  const logout = await request(app).delete('/api/v1/auth/session').set('Origin', origin).set('x-izone-csrf', '1').set('Cookie', cookie);
  assert.equal(logout.status, 200);
  assert.match(logout.headers['set-cookie'][0], /Max-Age=0/u);
});
