// Dữ liệu nhận vào: URL API staging, token nội bộ và roster 40 học viên hoàn toàn giả.
// Việc chính: kiểm tra lưu động 18 ô, chống Check trùng, tách hàng đợi Lesson 13,
// khóa section khi đạt, lỗi kỹ thuật, heartbeat và xác nhận API không còn trần bốn lượt chấm.
// Kết quả: chỉ in số liệu tổng hợp; không in tên, nội dung bài, UUID hoặc token.
// Khi lỗi: tiến trình dừng với tên phép kiểm tra; xem log staging, không xem log production.
const baseUrl = String(process.env.API_BASE_URL || '').replace(/\/$/, '');
const internalToken = process.env.INTERNAL_API_TOKEN;
const activitySlug = 'writing-lesson13-young-leaders';

if (!baseUrl || !internalToken) throw new Error('Cần API_BASE_URL và INTERNAL_API_TOKEN.');

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, { internal = false, body, headers = {}, ...options } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(internal ? { authorization: `Bearer ${internalToken}` } : {}),
      ...headers
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
  const value = await response.json().catch(() => ({}));
  return { status: response.status, value, etag: response.headers.get('etag') };
}

const responseKeys = [
  'body1_idea1', 'body1_idea2', 'body1_topic',
  'body1_support1_a', 'body1_support1_x', 'body1_support1_b',
  'body1_support2_a', 'body1_support2_x', 'body1_support2_b',
  'body2_idea1', 'body2_idea2', 'body2_topic',
  'body2_support1_a', 'body2_support1_x', 'body2_support1_b',
  'body2_support2_a', 'body2_support2_x', 'body2_support2_b'
];

function syntheticResponses(label) {
  return Object.fromEntries(responseKeys.map(key => [key, `${label} ${key}`]));
}

const roster = await request(`/api/v1/activities/${activitySlug}/roster`);
ensure(roster.status === 200, `Roster trả HTTP ${roster.status}.`);
const students = (roster.value.classes || []).flatMap(group =>
  (group.students || []).map(student => ({ classRef: group.classRef, studentRef: student.studentRef }))
);
ensure(students.length === 40, `Roster phải có 40 học viên giả, hiện có ${students.length}.`);

async function openSession(index) {
  const response = await request('/api/v1/lesson-sessions', {
    method: 'POST',
    body: { activitySlug, ...students[index] }
  });
  ensure(response.status === 201, `Mở phiên ${index + 1} trả HTTP ${response.status}.`);
  return response.value.session;
}

async function save(session, responses, requestId = crypto.randomUUID()) {
  return request(`/api/v1/lesson-sessions/${session.sessionRef}/responses`, {
    method: 'PUT',
    body: { baseVersion: session.draftVersion, requestId, responses }
  });
}

async function check(sessionRef, section, requestId = crypto.randomUUID()) {
  return request(`/api/v1/lesson-sessions/${sessionRef}/checks`, {
    method: 'POST', body: { section, requestId }
  });
}

async function claim(maxJobs = 1, workerPool = 'lesson13') {
  return request('/api/v1/internal/grading-jobs/claim', {
    internal: true,
    method: 'POST',
    body: { workerId: 'lesson13-staging-test', workerPool, maxJobs, leaseSeconds: 420 }
  });
}

async function complete(job, resultStatus, feedback, artifacts = {}) {
  return request(`/api/v1/internal/grading-jobs/${job.jobRef}/complete`, {
    internal: true,
    method: 'POST',
    body: { leaseToken: job.leaseToken, resultStatus, feedback, artifacts }
  });
}

async function fail(job) {
  return request(`/api/v1/internal/grading-jobs/${job.jobRef}/fail`, {
    internal: true,
    method: 'POST',
    body: { leaseToken: job.leaseToken, errorCode: 'LESSON13_STAGING_ERROR', retryable: false }
  });
}

const first = await openSession(0);
const blank = await check(first.sessionRef, 'body1_topic');
ensure(blank.status === 400, `Section trống phải nhận 400, hiện nhận ${blank.status}.`);

const savedFirst = await save(first, syntheticResponses('Bản kiểm thử'));
ensure(savedFirst.status === 200, `Lưu 18 ô trả HTTP ${savedFirst.status}.`);
const firstSavedSession = savedFirst.value.session;

const stale = await request(`/api/v1/lesson-sessions/${first.sessionRef}/responses`, {
  method: 'PUT',
  body: { baseVersion: first.draftVersion, requestId: crypto.randomUUID(), responses: syntheticResponses('Bản cũ') }
});
ensure(stale.status === 409, `Bản cũ phải nhận 409, hiện nhận ${stale.status}.`);

const repeatedRequestId = crypto.randomUUID();
const rapid = await Promise.all(Array.from({ length: 20 }, () =>
  check(first.sessionRef, 'body1_topic', repeatedRequestId)
));
ensure(rapid.every(item => item.status === 202), 'Có Check trùng không được chấp nhận.');
ensure(new Set(rapid.map(item => item.value.attempt?.attemptRef)).size === 1,
  '20 Check trùng đã tạo nhiều hơn một attempt.');

const defaultPool = await claim(1, 'task1');
ensure(defaultPool.status === 200 && defaultPool.value.jobs?.length === 0,
  'Hàng đợi Task 1 đã nhận nhầm việc Lesson 13.');

const firstClaim = await claim();
ensure(firstClaim.value.jobs?.length === 1, 'Không claim được việc Lesson 13.');
ensure(firstClaim.value.jobs[0].workerPool === 'lesson13', 'Job không mang đúng workerPool lesson13.');
const firstComplete = await complete(firstClaim.value.jobs[0], 'needs_revision', 'Nhận xét staging lần 1.');
ensure(firstComplete.status === 200, 'Không hoàn tất được lượt needs_revision.');

let latestAttempt;
for (let number = 2; number <= 3; number += 1) {
  latestAttempt = await check(first.sessionRef, 'body1_topic');
  ensure(latestAttempt.status === 202, `Check lần ${number} không được tạo.`);
  const job = await claim();
  ensure(job.value.jobs?.length === 1, `Không claim được lần ${number}.`);
  const done = await complete(job.value.jobs[0], 'needs_revision', `Nhận xét staging lần ${number}.`);
  ensure(done.status === 200, `Không hoàn tất được lần ${number}.`);
}
const polledThird = await request(`/api/v1/attempts/${latestAttempt.value.attempt.attemptRef}`);
ensure(polledThird.value.attempt?.supportWarning === true, 'Lần chưa đạt thứ ba chưa tạo cảnh báo hỗ trợ.');

const passAttempt = await check(first.sessionRef, 'body1_support1');
ensure(passAttempt.status === 202, 'Không tạo được lượt thử passed.');
const passJob = await claim();
ensure(passJob.value.jobs?.length === 1, 'Không claim được lượt thử passed.');
const passDone = await complete(passJob.value.jobs[0], 'passed', '👍 Đã đạt.', {
  vocabulary: { body1: [{ idea: 'Ý giả', terms: 'synthetic term' }] }
});
ensure(passDone.status === 200, 'Không hoàn tất được lượt passed.');
ensure((await check(first.sessionRef, 'body1_support1')).status === 423,
  'Section đã đạt chưa bị khóa ở API.');

const technical = await check(first.sessionRef, 'body1_support2');
ensure(technical.status === 202, 'Không tạo được lượt lỗi kỹ thuật.');
const technicalJob = await claim();
ensure(technicalJob.value.jobs?.length === 1, 'Không claim được lượt lỗi kỹ thuật.');
ensure((await fail(technicalJob.value.jobs[0])).status === 200, 'Không ghi được lỗi kỹ thuật.');
const afterTechnical = await request(`/api/v1/lesson-sessions/${first.sessionRef}`);
ensure(afterTechnical.value.session?.sections?.body1_support2?.attemptsWithoutPass === 0,
  'Lỗi kỹ thuật đã tăng chuỗi chưa đạt.');

const heartbeat = await request(`/api/v1/lesson-sessions/${first.sessionRef}/live`, {
  method: 'PUT', body: { activeField: 'body2_topic' }
});
ensure(heartbeat.status === 200 && heartbeat.value.accepted === true, 'Heartbeat không được chấp nhận.');

const remainingSessions = await Promise.all(Array.from({ length: 39 }, (_, index) => openSession(index + 1)));
const remainingSaved = await Promise.all(remainingSessions.map((session, index) =>
  save(session, syntheticResponses(`Học viên giả ${index + 2}`))
));
ensure(remainingSaved.every(item => item.status === 200), '40 lượt lưu đồng thời không hoàn tất.');

const capacityChecks = await Promise.all(remainingSessions.slice(0, 6).map(session =>
  check(session.sessionRef, 'body2_topic')
));
ensure(capacityChecks.every(item => item.status === 202), 'Không tạo đủ sáu job kiểm tra hàng đợi.');
const leased = await claim(4);
ensure(leased.value.jobs?.length === 4, `Phải lease bốn job, hiện có ${leased.value.jobs?.length || 0}.`);
const remaining = await claim(4);
ensure(remaining.value.jobs?.length === 2, 'API vẫn đang chặn các job còn lại ở giới hạn bốn.');
for (const job of leased.value.jobs) ensure((await fail(job)).status === 200, 'Không đóng được job capacity.');
for (const job of remaining.value.jobs) ensure((await fail(job)).status === 200, 'Không đóng được job capacity còn lại.');

console.log(JSON.stringify({
  ok: true,
  syntheticStudents: students.length,
  dynamicFields: responseKeys.length,
  repeatedChecks: rapid.length,
  leasedWithoutApiCap: leased.value.jobs.length + remaining.value.jobs.length,
  teacherAggregatePollingSeconds: 5
}));
