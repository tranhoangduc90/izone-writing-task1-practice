// Dữ liệu nhận vào: URL API staging, token nội bộ và roster 40 học viên giả.
// Việc chính: kiểm tra ô trống, xung đột hai tab, chống Check trùng, cảnh báo lần 3/6/9,
// lỗi kỹ thuật, khóa khi đạt, ETag và giới hạn bốn lượt chấm đồng thời.
// Kết quả: chỉ in số liệu tổng hợp; không in tên, bài làm, token hoặc mã nội bộ.
// Khi lỗi: tiến trình dừng với tên phép kiểm tra bị lỗi để đối chiếu log API/PostgreSQL.
const baseUrl = String(process.env.API_BASE_URL || '').replace(/\/$/, '');
const activitySlug = process.env.ACTIVITY_SLUG || 'staging-task-1';
const internalToken = process.env.INTERNAL_API_TOKEN;

if (!baseUrl || !internalToken) {
  throw new Error('Cần API_BASE_URL và INTERNAL_API_TOKEN.');
}

function ensure(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(path, { internal = false, headers = {}, body, ...options } = {}) {
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

const roster = await request(`/api/v1/activities/${activitySlug}/roster`);
ensure(roster.status === 200, `Roster trả HTTP ${roster.status}.`);
const students = (roster.value.classes || []).flatMap(group =>
  (group.students || []).map(student => ({ classRef: group.classRef, studentRef: student.studentRef }))
);
ensure(students.length === 40, `Roster staging phải có 40 học viên giả, hiện có ${students.length}.`);

async function openSession(index) {
  const response = await request('/api/v1/sessions', {
    method: 'POST',
    body: { activitySlug, ...students[index] }
  });
  ensure(response.status === 201, `Mở phiên ${index + 1} trả HTTP ${response.status}.`);
  return response.value.session;
}

async function submitOverview(sessionRef, text, requestId = crypto.randomUUID()) {
  return request(`/api/v1/sessions/${sessionRef}/checks`, {
    method: 'POST',
    body: {
      section: 'overview',
      requestId,
      snapshot: { overview: text, body1: '', body2: '' }
    }
  });
}

async function claim(maxJobs = 1) {
  return request('/api/v1/internal/grading-jobs/claim', {
    internal: true,
    method: 'POST',
    body: { workerId: 'staging-integration-test', maxJobs, leaseSeconds: 420 }
  });
}

async function complete(job, resultStatus, feedback) {
  return request(`/api/v1/internal/grading-jobs/${job.jobRef}/complete`, {
    internal: true,
    method: 'POST',
    body: { leaseToken: job.leaseToken, resultStatus, feedback }
  });
}

async function fail(job, retryable = false) {
  return request(`/api/v1/internal/grading-jobs/${job.jobRef}/fail`, {
    internal: true,
    method: 'POST',
    body: { leaseToken: job.leaseToken, errorCode: 'STAGING_TEST_ERROR', retryable }
  });
}

const first = await openSession(0);
const emptyOverview = await submitOverview(first.sessionRef, '\u200B \n\t');
ensure(emptyOverview.status === 400, `Overview trống phải bị chặn, nhận HTTP ${emptyOverview.status}.`);
const emptyOutline = await request(`/api/v1/sessions/${first.sessionRef}/checks`, {
  method: 'POST',
  body: {
    section: 'outline',
    requestId: crypto.randomUUID(),
    snapshot: { overview: '', body1: '\u2060 ', body2: '\uFEFF' }
  }
});
ensure(emptyOutline.status === 400, `Outline trống phải bị chặn, nhận HTTP ${emptyOutline.status}.`);

const saved = await request(`/api/v1/sessions/${first.sessionRef}/draft`, {
  method: 'PUT',
  body: {
    baseVersion: first.draftVersion,
    requestId: crypto.randomUUID(),
    overview: 'Bản nháp staging hợp lệ.',
    body1: '',
    body2: ''
  }
});
ensure(saved.status === 200, `Lưu bản nháp trả HTTP ${saved.status}.`);
const staleSave = await request(`/api/v1/sessions/${first.sessionRef}/draft`, {
  method: 'PUT',
  body: {
    baseVersion: first.draftVersion,
    requestId: crypto.randomUUID(),
    overview: 'Bản cũ không được ghi đè.',
    body1: '',
    body2: ''
  }
});
ensure(staleSave.status === 409, `Bản nháp cũ phải nhận 409, nhận HTTP ${staleSave.status}.`);

const rapidChecks = await Promise.all(Array.from({ length: 20 }, () =>
  submitOverview(first.sessionRef, 'Nội dung kiểm thử chống tạo trùng.')
));
ensure(rapidChecks.every(item => item.status === 202), 'Có Check đồng thời không được chấp nhận.');
const rapidAttemptRefs = new Set(rapidChecks.map(item => item.value.attempt?.attemptRef));
ensure(rapidAttemptRefs.size === 1, `20 Check đã tạo ${rapidAttemptRefs.size} lượt thay vì một.`);

const warnings = [];
let currentAttempt = rapidChecks[0];
let etagValidated = false;
for (let attemptNumber = 1; attemptNumber <= 9; attemptNumber += 1) {
  if (attemptNumber > 1) {
    currentAttempt = await submitOverview(first.sessionRef, `Nội dung sửa lần ${attemptNumber}.`);
    ensure(currentAttempt.status === 202, `Check lần ${attemptNumber} trả HTTP ${currentAttempt.status}.`);
  }
  const claimed = await claim();
  ensure(claimed.status === 200 && claimed.value.jobs?.length === 1, `Không lấy được job lần ${attemptNumber}.`);
  const completed = await complete(claimed.value.jobs[0], 'needs_revision', `Phản hồi thử nghiệm lần ${attemptNumber}.`);
  ensure(completed.status === 200, `Hoàn tất job lần ${attemptNumber} trả HTTP ${completed.status}.`);
  const attemptRef = currentAttempt.value.attempt.attemptRef;
  const polled = await request(`/api/v1/attempts/${attemptRef}`);
  ensure(polled.status === 200 && polled.value.attempt?.resultStatus === 'needs_revision', `Polling lần ${attemptNumber} sai kết quả.`);
  const expectedWarning = attemptNumber % 3 === 0;
  ensure(Boolean(polled.value.attempt.supportWarning) === expectedWarning, `Cảnh báo hỗ trợ sai ở lần ${attemptNumber}.`);
  if (expectedWarning) warnings.push(attemptNumber);
  if (!etagValidated) {
    ensure(Boolean(polled.etag), 'Polling không trả ETag.');
    const unchanged = await request(`/api/v1/attempts/${attemptRef}`, { headers: { 'if-none-match': polled.etag } });
    ensure(unchanged.status === 304, `ETag không trả 304, nhận HTTP ${unchanged.status}.`);
    etagValidated = true;
  }
}

const technicalSession = await openSession(1);
const technicalAttempt = await submitOverview(technicalSession.sessionRef, 'Nội dung thử lỗi kỹ thuật.');
ensure(technicalAttempt.status === 202, 'Không tạo được lượt thử lỗi kỹ thuật.');
const technicalClaim = await claim();
ensure(technicalClaim.value.jobs?.length === 1, 'Không lấy được job thử lỗi kỹ thuật.');
const technicalFail = await fail(technicalClaim.value.jobs[0], false);
ensure(technicalFail.status === 200, `Ghi lỗi kỹ thuật trả HTTP ${technicalFail.status}.`);
const technicalState = await request(`/api/v1/sessions/${technicalSession.sessionRef}`);
ensure(technicalState.value.session?.sections?.overview?.failStreak === 0, 'Lỗi kỹ thuật đã làm tăng chuỗi chưa đạt.');

const passedSession = await openSession(2);
const passedAttempt = await submitOverview(passedSession.sessionRef, 'Nội dung thử trạng thái đạt.');
ensure(passedAttempt.status === 202, 'Không tạo được lượt thử trạng thái đạt.');
const passedClaim = await claim();
ensure(passedClaim.value.jobs?.length === 1, 'Không lấy được job thử trạng thái đạt.');
const passedComplete = await complete(passedClaim.value.jobs[0], 'passed', 'Đã đạt trong kiểm thử staging.');
ensure(passedComplete.status === 200, `Ghi trạng thái đạt trả HTTP ${passedComplete.status}.`);
const lockedCheck = await submitOverview(passedSession.sessionRef, 'Không được tạo thêm sau khi đạt.');
ensure(lockedCheck.status === 423, `Phần đã đạt phải bị khóa, nhận HTTP ${lockedCheck.status}.`);

const capacitySessions = await Promise.all([3, 4, 5, 6, 7, 8].map(openSession));
const capacityAttempts = await Promise.all(capacitySessions.map((session, index) =>
  submitOverview(session.sessionRef, `Nội dung thử giới hạn đồng thời ${index + 1}.`)
));
ensure(capacityAttempts.every(item => item.status === 202), 'Không tạo đủ sáu job thử giới hạn đồng thời.');
const firstBatch = await claim(4);
ensure(firstBatch.value.jobs?.length === 4, `Lần lấy đầu phải có 4 job, nhận ${firstBatch.value.jobs?.length ?? 0}.`);
const blockedBatch = await claim(4);
ensure(blockedBatch.value.jobs?.length === 0, 'Hệ thống đã cho thuê quá bốn job đồng thời.');
for (const job of firstBatch.value.jobs) {
  const failed = await fail(job, false);
  ensure(failed.status === 200, 'Không đóng được job của phép thử giới hạn.');
}
const secondBatch = await claim(4);
ensure(secondBatch.value.jobs?.length === 2, `Lần lấy sau phải có 2 job, nhận ${secondBatch.value.jobs?.length ?? 0}.`);
for (const job of secondBatch.value.jobs) {
  const failed = await fail(job, false);
  ensure(failed.status === 200, 'Không đóng được job còn lại của phép thử giới hạn.');
}

// Kiểm thử Draft trên PostgreSQL thật: bị chặn trước khi Overview/Outline đạt,
// chỉ chấm đúng bản đã lưu và khóa riêng phần Draft sau khi đạt.
const draftSession = await openSession(9);
const draftSaved = await request(`/api/v1/sessions/${draftSession.sessionRef}/draft`, {
  method: 'PUT',
  body: {
    baseVersion: draftSession.draftVersion,
    requestId: crypto.randomUUID(),
    overview: 'Overview giả dùng cho kiểm thử Draft.',
    body1: 'Outline Body 1 giả dùng cho kiểm thử Draft.',
    body2: 'Outline Body 2 giả dùng cho kiểm thử Draft.',
    draft1: 'Draft 1 giả có phần <cần sửa>.',
    draft2: 'Draft 2 synthetic with the local issue corrected.',
    draft2Unlocked: true
  }
});
ensure(draftSaved.status === 200, `Lưu đủ dữ liệu Draft trả HTTP ${draftSaved.status}.`);

async function submitSavedSection(sessionRef, section, snapshot) {
  return request(`/api/v1/sessions/${sessionRef}/checks`, {
    method: 'POST',
    body: { section, requestId: crypto.randomUUID(), snapshot }
  });
}

const draftSnapshot = {
  overview: 'Overview giả dùng cho kiểm thử Draft.',
  body1: 'Outline Body 1 giả dùng cho kiểm thử Draft.',
  body2: 'Outline Body 2 giả dùng cho kiểm thử Draft.',
  draft1: 'Draft 1 giả có phần <cần sửa>.',
  draft2: 'Draft 2 synthetic with the local issue corrected.'
};
const prematureDraft = await submitSavedSection(draftSession.sessionRef, 'draft', draftSnapshot);
ensure(prematureDraft.status === 409, `Draft trước điều kiện phải nhận 409, nhận HTTP ${prematureDraft.status}.`);

for (const section of ['overview', 'outline']) {
  const submitted = await submitSavedSection(draftSession.sessionRef, section, draftSnapshot);
  ensure(submitted.status === 202, `Gửi ${section} cho điều kiện Draft trả HTTP ${submitted.status}.`);
  const claimed = await claim();
  ensure(claimed.value.jobs?.length === 1 && claimed.value.jobs[0].section === section, `Job điều kiện ${section} không đúng.`);
  const completed = await complete(claimed.value.jobs[0], 'passed', `${section} đã đạt trong kiểm thử Draft.`);
  ensure(completed.status === 200, `Hoàn tất điều kiện ${section} trả HTTP ${completed.status}.`);
}

const draftAttempt = await submitSavedSection(draftSession.sessionRef, 'draft', draftSnapshot);
ensure(draftAttempt.status === 202, `Gửi Draft hợp lệ trả HTTP ${draftAttempt.status}.`);
const draftClaim = await claim();
const draftJob = draftClaim.value.jobs?.[0];
ensure(draftClaim.status === 200 && draftJob?.section === 'draft', 'Không nhận được job Draft độc lập.');
ensure(draftJob.studentInput?.draft1 === draftSnapshot.draft1 && draftJob.studentInput?.draft2 === draftSnapshot.draft2, 'Job Draft không mang đúng Draft 1/2 đã lưu.');
const draftCompleted = await complete(draftJob, 'passed', 'Draft đã đạt trong kiểm thử staging.');
ensure(draftCompleted.status === 200, `Hoàn tất Draft trả HTTP ${draftCompleted.status}.`);
const lockedDraft = await submitSavedSection(draftSession.sessionRef, 'draft', draftSnapshot);
ensure(lockedDraft.status === 423, `Draft đã đạt phải bị khóa, nhận HTTP ${lockedDraft.status}.`);

process.stdout.write(`${JSON.stringify({
  syntheticStudents: students.length,
  rapidChecks: rapidChecks.length,
  rapidAttemptRefCount: rapidAttemptRefs.size,
  supportWarningsAt: warnings,
  staleDraftStatus: staleSave.status,
  emptyOverviewStatus: emptyOverview.status,
  emptyOutlineStatus: emptyOutline.status,
  lockedSectionStatus: lockedCheck.status,
  etagValidated,
  maximumConcurrentLeases: firstBatch.value.jobs.length,
  draftBeforePrerequisitesStatus: prematureDraft.status,
  draftJobSection: draftJob.section,
  lockedDraftStatus: lockedDraft.status
})}\n`);
