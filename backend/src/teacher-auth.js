import { OAuth2Client } from 'google-auth-library';

// Nhận Google ID token của giảng viên, xác minh chữ ký/audience rồi kiểm quyền
// trong reviewer_account. Lỗi xác thực chỉ trả trạng thái chung, không lộ token.
export function createTeacherAuthMiddleware({ config, pool, verifyGoogleToken }) {
  const oauthClient = new OAuth2Client(config.googleClientId);
  const verify = verifyGoogleToken || (async token => {
    const ticket = await oauthClient.verifyIdToken({ idToken: token, audience: config.googleClientId });
    return ticket.getPayload();
  });
  return async function teacherAuth(req, res, next) {
    const authorization = req.get('authorization') || '';
    const token = authorization.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
    if (!token) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    let payload;
    try { payload = await verify(token); } catch { return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' }); }
    const email = String(payload?.email || '').trim().toLowerCase();
    const subject = String(payload?.sub || '').trim();
    if (!email || !subject || payload?.email_verified !== true) return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
    const account = await pool.query(`UPDATE mapping.reviewer_account
      SET google_subject=COALESCE(google_subject,$2),last_login_at=now(),updated_at=now()
      WHERE email=$1 AND status='active' AND (google_subject IS NULL OR google_subject=$2)
      RETURNING email,role,can_access_all_classes`, [email, subject]);
    if (account.rowCount !== 1 || !['admin', 'teacher'].includes(account.rows[0].role)) return res.status(403).json({ ok: false, error: 'ACCESS_DENIED' });
    // Quyền toàn hệ thống của dashboard Writing chỉ dựa trên role=admin.
    // Cờ cũ can_access_all_classes không được dùng để vượt phạm vi lớp của giảng viên.
    const canManage = account.rows[0].role === 'admin';
    req.reviewer = {
      email: account.rows[0].email,
      role: account.rows[0].role,
      canAccessAllClasses: canManage,
      canManage
    };
    return next();
  };
}
