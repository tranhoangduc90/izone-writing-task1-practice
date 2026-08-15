import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabasePool } from './db.js';
import { createWritingPracticeService } from './service.js';
import { createLessonPracticeService } from './lesson-service.js';
import { createTeacherAuthMiddleware } from './teacher-auth.js';
import { createProvisionalStudentService } from './provisional-service.js';

const config = loadConfig();
const pool = createDatabasePool(config);
const provisionalService = createProvisionalStudentService({ pool, pepper: config.provisionalStudentPinPepper });
const app = createApp({
  config,
  pool,
  service: createWritingPracticeService({ pool, provisionalService }),
  lessonService: createLessonPracticeService({ pool, provisionalService }),
  provisionalService,
  adminAuth: createTeacherAuthMiddleware({ config, pool })
});
const server = app.listen(config.port, '0.0.0.0', () => console.log(`Writing Task 1 API đang lắng nghe tại cổng ${config.port}.`));
server.requestTimeout = 30_000;
server.headersTimeout = 31_000;
server.keepAliveTimeout = 5_000;

async function shutdown(signal) {
  console.log(`Nhận ${signal}; đang đóng API an toàn.`);
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
