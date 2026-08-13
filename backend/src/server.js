import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabasePool } from './db.js';
import { createWritingPracticeService } from './service.js';
import { createTeacherAuthMiddleware } from './teacher-auth.js';

const config = loadConfig();
const pool = createDatabasePool(config);
const app = createApp({ config, pool, service: createWritingPracticeService({ pool }), adminAuth: createTeacherAuthMiddleware({ config, pool }) });
const server = app.listen(config.port, '0.0.0.0', () => console.log(`Writing Task 1 API đang lắng nghe tại cổng ${config.port}.`));
server.requestTimeout = 15_000;
server.headersTimeout = 16_000;
server.keepAliveTimeout = 5_000;

async function shutdown(signal) {
  console.log(`Nhận ${signal}; đang đóng API an toàn.`);
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
