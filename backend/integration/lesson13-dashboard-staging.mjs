// Dữ liệu nhận vào: DATABASE_URL staging từ môi trường container và activity 40 học viên giả.
// Việc chính: gọi đúng service của dashboard để kiểm tra truy vấn tổng hợp PostgreSQL thật.
// Kết quả: chỉ in số học viên, số section và các field trạng thái; không in tên hay bài làm.
// Khi lỗi: tiến trình dừng trước production; xem lỗi trong terminal staging.
import { loadConfig } from '/app/src/config.js';
import { createDatabasePool } from '/app/src/db.js';
import { createLessonPracticeService } from '/app/src/lesson-service.js';

const config = loadConfig();
const pool = createDatabasePool(config);

try {
  const service = createLessonPracticeService({ pool });
  const result = await service.listLive({
    activitySlug: 'writing-lesson13-young-leaders',
    classRef: null
  });
  if (result.students.length !== 40) {
    throw new Error(`Dashboard staging phải trả 40 học viên giả, hiện có ${result.students.length}.`);
  }
  const studentsWithSessions = result.students.filter(student => student.sessionRef);
  if (studentsWithSessions.length !== 40) throw new Error('Dashboard thiếu session staging.');
  if (studentsWithSessions.some(student => Object.keys(student.sections || {}).length !== 6)) {
    throw new Error('Dashboard chưa trả đủ sáu section cho mỗi học viên.');
  }
  console.log(JSON.stringify({
    ok: true,
    syntheticStudents: result.students.length,
    studentsWithSessions: studentsWithSessions.length,
    sectionsPerStudent: 6,
    aggregateRequest: true
  }));
} finally {
  await pool.end();
}
