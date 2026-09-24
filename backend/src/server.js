import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createDatabasePool } from './db.js';
import { createWritingPracticeService } from './service.js';
import { createLessonPracticeService } from './lesson-service.js';
import { createTeacherAuthService } from './teacher-auth.js';
import { createProvisionalStudentService } from './provisional-service.js';
import { createTeacherCommentService } from './teacher-comment-service.js';
import { createLmsResultService } from './lms-result-service.js';
import { createWritingFlowService } from './writing-flow-service.js';
import { createWritingFlowStage } from './writing-flow-stage.js';
import { createWritingFlowHandoff } from './writing-flow-handoff.js';
import { createWritingFlowAiCall } from './writing-flow-ai-call.js';
import { createWritingFlowScan } from './writing-flow-scan.js';
import { createWritingFlowTrccRepair } from './writing-flow-trcc-repair.js';
import { createWritingFlowNotifier } from './writing-flow-notifier.js';
import { createWebSubstituteIntake } from './writing-flow-web-intake.js';
import { createWebSubstituteQueue } from './writing-flow-web-queue.js';
import { getPinnedWebPrompt } from './writing-flow-web-registry.js';

const config = loadConfig();
const pool = createDatabasePool(config);
const writingFlowNotifier = createWritingFlowNotifier({
  pool,
  handoffUrl: config.writingFlowHandoffNotifyUrl,
  sourceUrl: config.writingFlowSourceNotifyUrl,
  secret: config.writingFlowNotifySecret
});
const provisionalService = createProvisionalStudentService({ pool, pepper: config.provisionalStudentPinPepper });
const teacherAuth = createTeacherAuthService({ config, pool });
const app = createApp({
  config,
  pool,
  service: createWritingPracticeService({ pool, provisionalService }),
  lessonService: createLessonPracticeService({ pool, provisionalService }),
  provisionalService,
  lmsResultService: createLmsResultService({ pool }),
  writingFlowService: createWritingFlowService({ pool, encryptionKey: config.writingFlowEncryptionKey }),
  writingFlowWebIntake: config.webSubstituteEnabled
    ? createWebSubstituteIntake({ pool, encryptionKey: config.writingFlowEncryptionKey,
      getPinnedPrompt: getPinnedWebPrompt }) : null,
  writingFlowWebQueue: config.webSubstituteEnabled
    ? createWebSubstituteQueue({ pool, encryptionKey: config.writingFlowEncryptionKey,
      getPinnedPrompt: getPinnedWebPrompt }) : null,
  writingFlowStage: createWritingFlowStage({ pool, encryptionKey: config.writingFlowEncryptionKey }),
  writingFlowHandoff: createWritingFlowHandoff({ pool }),
  writingFlowAiCall: createWritingFlowAiCall({ pool, encryptionKey: config.writingFlowEncryptionKey }),
  writingFlowScan: createWritingFlowScan({ pool }),
  writingFlowTrccRepair: createWritingFlowTrccRepair({
    pool, encryptionKey: config.writingFlowEncryptionKey }),
  teacherCommentService: createTeacherCommentService({ pool }),
  teacherAuth,
  adminAuth: teacherAuth.authenticate
});
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`Writing Task 1 API đang lắng nghe tại cổng ${config.port}.`);
  void writingFlowNotifier.start();
});
server.requestTimeout = 30_000;
server.headersTimeout = 31_000;
server.keepAliveTimeout = 5_000;

async function shutdown(signal) {
  await writingFlowNotifier.close();
  console.log(`Nhận ${signal}; đang đóng API an toàn.`);
  server.close(async () => { await pool.end(); process.exit(0); });
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
