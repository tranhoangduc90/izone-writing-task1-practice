/**
 * Nhận cấu hình riêng Reading/Listening; mặc định tắt để giữ nguyên Writing.
 * Khi bật, đòi token và kết nối DB riêng, không mượn secret hay pool Writing.
 * Lỗi trả mã ngắn; runtime chỉ khóa tuyến Reading/Listening, không dừng Writing.
 */
export function loadReadingListening67Config(env = process.env) {
  const enabled = env.READING_LISTENING67_ENABLED === 'true';
  if (!enabled) return { enabled: false };
  const token = String(env.READING_LISTENING67_INTERNAL_TOKEN || '');
  const databaseUrl = String(env.READING_LISTENING67_DATABASE_URL || '');
  if (token.length < 32) throw new Error('RL67_TOKEN_REQUIRED');
  if (!/^postgres(?:ql)?:\/\//.test(databaseUrl)) throw new Error('RL67_DATABASE_REQUIRED');
  if (databaseUrl === env.DATABASE_URL) throw new Error('RL67_SEPARATE_DATABASE_ROLE_REQUIRED');
  const db = new URL(databaseUrl);
  // Đổi mật khẩu/host không biến tài khoản Writing thành tài khoản có quyền riêng.
  if (decodeURIComponent(db.username) !== 'reading_listening67_api' || db.search) throw new Error('RL67_SEPARATE_DATABASE_ROLE_REQUIRED');
  const notifyUrl = String(env.READING_LISTENING67_NOTIFY_URL || '');
  if (!/^https:\/\//.test(notifyUrl)) throw new Error('RL67_NOTIFY_URL_REQUIRED');
  return { enabled: true, token, databaseUrl, notifyUrl, poolMax: 2 };
}
