// Dữ liệu nhận vào: URL API staging, token nội bộ và roster 40 học viên hoàn toàn giả.
// Việc chính: dọn hàng đợi staging cũ, tạo sáu lượt Check mới, giữ bốn lease rồi lấy tiếp hai lease.
// Kết quả: xác nhận API không còn trần bốn lượt; mọi job thử nghiệm được đóng ở trạng thái lỗi giả lập.
// Khi lỗi: tiến trình dừng với tên phép kiểm tra; chỉ xem log staging, không xem hoặc sửa dữ liệu production.
const baseUrl = String(process.env.API_BASE_URL || '').replace(/\/$/, '');
const internalToken = process.env.INTERNAL_API_TOKEN;
const activitySlug = 'writing-lesson13-young-leaders';

if (!baseUrl || !internalToken) throw new Error('Cần API_BASE_URL và INTERNAL_API_TOKEN.');

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, { internal = false, body, ...options } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(internal ? { authorization: `Bearer ${internalToken}` } : {})
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const value = await response.json().catch(() => ({}));
  return { status: response.status, value };
}

async function claim(maxJobs) {
  return request('/api/v1/internal/grading-jobs/claim', {
    internal: true,
    method: 'POST',
    body: { workerId: 'staging-unlimited-claim-test', workerPool: 'lesson13', maxJobs, leaseSeconds: 420 }
  });
}

async function fail(job) {
  return request(`/api/v1/internal/grading-jobs/${job.jobRef}/fail`, {
    internal: true,
    method: 'POST',
    body: { leaseToken: job.leaseToken, errorCode: 'STAGING_TEST_CLEANUP', retryable: false }
  });
}

// Dọn các job staging cũ để số lượng đo được chỉ gồm sáu job của phép thử này.
const old = await claim(100);
ensure(old.status === 200, `Không đọc được hàng đợi staging, HTTP ${old.status}.`);
for (const job of old.value.jobs || []) ensure((await fail(job)).status === 200, 'Không đóng được job staging cũ.');

const roster = await request(`/api/v1/activities/${activitySlug}/roster`);
ensure(roster.status === 200, `Roster staging trả HTTP ${roster.status}.`);
const students = (roster.value.classes || []).flatMap(group =>
  (group.students || []).map(student => ({ classRef: group.classRef, studentRef: student.studentRef }))
);
ensure(students.length >= 12, 'Roster staging không đủ học viên giả cho phép thử.');

const responseKeys = [
  'body1_idea1', 'body1_idea2', 'body1_topic',
  'body1_support1_a', 'body1_support1_x', 'body1_support1_b',
  'body1_support2_a', 'body1_support2_x', 'body1_support2_b',
  'body2_idea1', 'body2_idea2', 'body2_topic',
  'body2_support1_a', 'body2_support1_x', 'body2_support1_b',
  'body2_support2_a', 'body2_support2_x', 'body2_support2_b'
];
const candidateSections = ['body2_support2', 'body2_support1', 'body1_support2', 'body1_support1', 'body2_topic', 'body1_topic'];
let created = 0;

for (const student of students.slice(6, 20)) {
  if (created === 6) break;
  const opened = await request('/api/v1/lesson-sessions', {
    method: 'POST',
    body: { activitySlug, ...student }
  });
  ensure(opened.status === 201, `Không mở được phiên staging, HTTP ${opened.status}.`);
  const session = opened.value.session;
  const responses = Object.fromEntries(responseKeys.map(key => [key, `Nội dung giả ${key}`]));
  const saved = await request(`/api/v1/lesson-sessions/${session.sessionRef}/responses`, {
    method: 'PUT',
    body: { baseVersion: session.draftVersion, requestId: crypto.randomUUID(), responses }
  });
  ensure(saved.status === 200, `Không lưu được phiên staging, HTTP ${saved.status}.`);

  for (const section of candidateSections) {
    const checked = await request(`/api/v1/lesson-sessions/${session.sessionRef}/checks`, {
      method: 'POST',
      body: { section, requestId: crypto.randomUUID() }
    });
    if (checked.status === 202) {
      created += 1;
      break;
    }
  }
}

ensure(created === 6, `Chỉ tạo được ${created}/6 job staging.`);
const first = await claim(4);
const second = await claim(4);
ensure(first.status === 200 && first.value.jobs?.length === 4, 'Lần claim đầu không nhận đủ bốn job.');
ensure(second.status === 200 && second.value.jobs?.length === 2, 'API vẫn chặn hai job sau khi đã lease bốn job.');

for (const job of [...first.value.jobs, ...second.value.jobs]) {
  ensure((await fail(job)).status === 200, 'Không đóng được job của phép thử unlimited claim.');
}

console.log(JSON.stringify({ ok: true, firstClaim: 4, secondClaimWhileFourLeased: 2, totalLeased: 6 }));
