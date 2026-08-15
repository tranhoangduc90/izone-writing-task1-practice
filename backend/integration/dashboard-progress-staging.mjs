// Dữ liệu nhận vào: API/database staging và duy nhất một hồ sơ giả có tiền tố ZZ.
// Việc chính: tạo ba lượt chưa đạt, kiểm tra cảnh báo dashboard, sau đó cho đạt để kiểm tra cảnh báo được gỡ.
// Kết quả: in các cờ tổng hợp; không in tên, bài, UUID, token hoặc mã truy cập.
// Khi lỗi: dừng ngay; script cleanup-provisional-staging.sql xóa toàn bộ dữ liệu giả.
import { loadConfig } from '../src/config.js';
import { createDatabasePool } from '../src/db.js';
import { createLessonPracticeService } from '../src/lesson-service.js';

const config = loadConfig();
const pool = createDatabasePool(config);
const service = createLessonPracticeService({ pool });
const apiBase = 'http://writing-task1-practice-api-staging:8790';
const activitySlug = 'staging-task-1';

function ensure(value, message) { if (!value) throw new Error(message); }
async function call(path, { internal = false, body, ...options } = {}) {
  const response = await fetch(`${apiBase}${path}`, { ...options, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(internal ? { authorization: `Bearer ${config.internalApiToken}` } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const data = await response.json().catch(() => ({})); return { status: response.status, data };
}

try {
  const roster = await call(`/api/v1/activities/${activitySlug}/roster`);
  const group = roster.data.classes[0];
  const student = group.students.find(item => item.provisional && item.displayName?.startsWith('ZZ Kiểm thử tạm 01'));
  ensure(student, 'Thiếu hồ sơ tạm giả để kiểm tra dashboard.');
  const opened = await call('/api/v1/sessions', { method: 'POST', body: { activitySlug, classRef: group.classRef, studentRef: student.studentRef, accessCode: '2468' } });
  ensure(opened.status === 201, 'Không mở được session kiểm tra dashboard.');
  let session = opened.data.session;
  const saved = await call(`/api/v1/sessions/${session.sessionRef}/draft`, { method: 'PUT', body: { baseVersion: session.draftVersion, requestId: crypto.randomUUID(), overview: 'Nội dung giả kiểm tra dashboard.', body1: '', body2: '', draft1: '', draft2: '' } });
  ensure(saved.status === 200, 'Không lưu được tiến trình giả.');
  session = saved.data.session;

  async function grade(resultStatus) {
    const checked = await call(`/api/v1/sessions/${session.sessionRef}/checks`, { method: 'POST', body: { section: 'overview', requestId: crypto.randomUUID(), snapshot: { overview: 'Nội dung giả kiểm tra dashboard.', body1: '', body2: '', draft1: '', draft2: '' } } });
    ensure(checked.status === 202, 'Không tạo được lượt Check giả.');
    const claimed = await call('/api/v1/internal/grading-jobs/claim', { internal: true, method: 'POST', body: { workerId: 'dashboard-staging-check', maxJobs: 1, leaseSeconds: 420 } });
    const job = claimed.data.jobs?.[0];
    ensure(job?.attemptRef === checked.data.attempt.attemptRef, 'Claim nhầm job staging.');
    const completed = await call(`/api/v1/internal/grading-jobs/${job.jobRef}/complete`, { internal: true, method: 'POST', body: { leaseToken: job.leaseToken, resultStatus, feedback: resultStatus === 'passed' ? '👍 Đã đạt.' : 'Cần sửa.' } });
    ensure(completed.status === 200, 'Không hoàn tất được lượt chấm giả.');
  }

  await grade('needs_revision'); await grade('needs_revision'); await grade('needs_revision');
  let live = await service.listLive({ activitySlug, classRef: group.classRef });
  let dashboardStudent = live.students.find(item => item.studentRef === student.studentRef);
  ensure(dashboardStudent.supportRequired && dashboardStudent.supportSections[0].commentNumber === 3, 'Comment 3 chưa bật ưu tiên hỗ trợ.');
  ensure(dashboardStudent.hasStarted && dashboardStudent.filledFields === 1 && dashboardStudent.totalFields === 5, 'Chỉ số tiến trình Task 1 sai.');
  await grade('passed');
  live = await service.listLive({ activitySlug, classRef: group.classRef });
  dashboardStudent = live.students.find(item => item.studentRef === student.studentRef);
  ensure(!dashboardStudent.supportRequired && dashboardStudent.passedSectionCount === 1, 'Đạt chưa gỡ cảnh báo hoặc chưa tăng phần đạt.');
  console.log(JSON.stringify({ commentThreePrioritized: true, task1ProgressCorrect: true, passClearsPriority: true }));
} finally {
  await pool.end();
}
