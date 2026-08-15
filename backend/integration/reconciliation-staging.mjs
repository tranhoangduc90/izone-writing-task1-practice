// Dữ liệu nhận vào: roster staging gồm hồ sơ chính thức và hồ sơ tạm hoàn toàn giả.
// Việc chính: ghép một hồ sơ, kiểm tra hai UUID mở cùng bài; thử xung đột khi hồ sơ chính thức đã có bài.
// Kết quả: chỉ in cờ tổng hợp, không in UUID/tên/mã hay nội dung bài.
import { loadConfig } from '../src/config.js';
import { createDatabasePool } from '../src/db.js';
import { createProvisionalStudentService } from '../src/provisional-service.js';
import { createWritingPracticeService } from '../src/service.js';
import { createLessonPracticeService } from '../src/lesson-service.js';

const config = loadConfig(); const pool = createDatabasePool(config);
const provisional = createProvisionalStudentService({ pool, pepper: config.provisionalStudentPinPepper });
const writing = createWritingPracticeService({ pool, provisionalService: provisional });
const dashboard = createLessonPracticeService({ pool });
const activitySlug = 'staging-task-1';
function ensure(value, message) { if (!value) throw new Error(message); }

try {
  const roster = await writing.getRoster(activitySlug); const group = roster.classes[0];
  const live = await dashboard.listLive({ activitySlug, classRef: group.classRef });
  const temporary = group.students.filter(item => item.provisional);
  const officialWithoutSession = live.students.find(item => !item.provisional && !item.sessionRef);
  const officialWithSession = live.students.find(item => !item.provisional && item.sessionRef);
  ensure(temporary.length >= 3 && officialWithoutSession && officialWithSession, 'Staging thiếu ứng viên đối soát/xung đột.');

  const source = temporary.find(item => item.displayName.startsWith('ZZ Kiểm thử tạm 01')) || temporary[0];
  const before = await writing.openSession({ activitySlug, classRef: group.classRef, studentRef: source.studentRef, accessCode: '2468' });
  await provisional.reconcile({ studentRef: source.studentRef, officialStudentRef: officialWithoutSession.studentRef, actorRef: 'staging-reviewer@example.invalid' });
  const officialOpen = await writing.openSession({ activitySlug, classRef: group.classRef, studentRef: officialWithoutSession.studentRef });
  const legacyOpen = await writing.openSession({ activitySlug, classRef: group.classRef, studentRef: source.studentRef });
  ensure(before.sessionRef === officialOpen.sessionRef && before.sessionRef === legacyOpen.sessionRef, 'Đối soát làm đổi session/UUID bài.');

  const conflictSource = temporary.find(item => item.studentRef !== source.studentRef && item.displayName.startsWith('ZZ Kiểm thử tạm 02'))
    || temporary.find(item => item.studentRef !== source.studentRef && !item.displayName.startsWith('ZZ Kiểm thử tạm 00'));
  await writing.openSession({ activitySlug, classRef: group.classRef, studentRef: conflictSource.studentRef, accessCode: '2468' });
  let conflictCode = '';
  try { await provisional.reconcile({ studentRef: conflictSource.studentRef, officialStudentRef: officialWithSession.studentRef, actorRef: 'staging-reviewer@example.invalid' }); }
  catch (error) { conflictCode = error.code; }
  ensure(conflictCode === 'RECONCILIATION_CONFLICT', 'Hai hồ sơ có bài không bị chặn 409.');
  const pending = await provisional.listPending({ activitySlug, classRef: group.classRef });
  ensure(pending.some(item => item.studentRef === conflictSource.studentRef), 'Xung đột đã làm thay đổi hồ sơ tạm.');
  console.log(JSON.stringify({ sessionPreserved: true, oldAndOfficialRefsWork: true, conflictBlockedWithoutMutation: true }));
} finally { await pool.end(); }
