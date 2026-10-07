/**
 * Nhận env riêng và tạo pool giới hạn hai kết nối khi bật module.
 * Cấu hình lỗi chỉ làm Reading/Listening unavailable; Writing vẫn khởi động.
 * Không tự chạy migration, đọc bảng Writing hoặc kế thừa notifier Writing.
 */
import pg from 'pg';
import { loadReadingListening67Config } from './config.js';
import { createReadingListening67Store } from './store.js';
import { createReadingListening67Notifier } from './notifier.js';
import { createReadingListening67AccessGuard } from './database-access.js';
export function createReadingListening67Runtime(env = process.env) {
  if (env.READING_LISTENING67_ENABLED !== 'true') return { mount: null, start() {}, close: async () => {} };
  try {
    const config = loadReadingListening67Config(env);
    const pool = new pg.Pool({ connectionString: config.databaseUrl, max: config.poolMax, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 3_000, statement_timeout: 5_000, application_name: 'reading_listening67_api' });
    pool.on('error', () => console.error('Reading/Listening 67: lỗi kết nối database nền.'));
    const rawStore = createReadingListening67Store({ pool });
    const checkAccess = createReadingListening67AccessGuard(pool);
    const store = Object.fromEntries(Object.entries(rawStore).map(([name, work]) => [name, async (...args) => {
      await checkAccess(); return work(...args);
    }]));
    const notifier = createReadingListening67Notifier({ store, url: config.notifyUrl, token: config.token });
    return { mount: { store, token: config.token }, start: notifier.start, close: async () => { await notifier.close(); await pool.end(); } };
  } catch (error) {
    console.error('Reading/Listening 67: cấu hình chưa hợp lệ; giữ Writing hoạt động.');
    return { mount: { unavailable: true, token: String(env.READING_LISTENING67_INTERNAL_TOKEN || '') }, start() {}, close: async () => {} };
  }
}
