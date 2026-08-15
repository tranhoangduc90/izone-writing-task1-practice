// Dữ liệu nhận vào: URL API staging và roster giả; mã chỉ tồn tại trong tiến trình kiểm thử.
// Việc chính: tạo 40 hồ sơ tạm đồng thời, thử idempotency, tên trùng, khóa mã và mở lại bài.
// Kết quả: chỉ in số lượng/trạng thái tổng hợp, không in mã, UUID hay tên đầy đủ.
// Khi lỗi: dừng ngay; dữ liệu có tiền tố kiểm thử được script SQL phát hành xóa sau đó.
const baseUrl = String(process.env.API_BASE_URL || '').replace(/\/$/, '');
const activitySlug = process.env.ACTIVITY_SLUG || 'staging-task-1';
if (!baseUrl) throw new Error('Thiếu API_BASE_URL.');

function ensure(value, message) { if (!value) throw new Error(message); }
async function call(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  return { status: response.status, data };
}

const roster = await call(`/api/v1/activities/${activitySlug}/roster`);
ensure(roster.status === 200 && roster.data.classes?.[0]?.classRef, 'Không lấy được lớp staging.');
const classRef = roster.data.classes[0].classRef;
const register = (index, requestId = crypto.randomUUID(), duplicateConfirmed = false) => call(`/api/v1/activities/${activitySlug}/provisional-students`, {
  method: 'POST', body: JSON.stringify({ classRef, displayName: `ZZ Kiểm thử tạm ${String(index).padStart(2, '0')}`, pin: '2468', requestId, duplicateConfirmed })
});

const sharedRequest = crypto.randomUUID();
const first = await register(0, sharedRequest);
const repeated = await register(0, sharedRequest);
ensure(first.status === 201 && repeated.status === 201, 'Request idempotent không trả 201.');
ensure(first.data.student.studentRef === repeated.data.student.studentRef, 'Request trùng tạo UUID khác.');
ensure(!JSON.stringify(first.data).includes('2468') && !('pinHash' in first.data.student), 'Response làm lộ mã/hash.');

const duplicate = await register(0);
ensure(duplicate.status === 409 && duplicate.data.error === 'PROVISIONAL_STUDENT_EXISTS', 'Tên trùng chưa bị yêu cầu xác nhận.');

for (let attempt = 1; attempt <= 5; attempt += 1) {
  const result = await call('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ activitySlug, classRef, studentRef: first.data.student.studentRef, accessCode: '0000' }) });
  ensure(result.status === (attempt === 5 ? 423 : 401), `Lần nhập sai ${attempt} trả HTTP ${result.status}.`);
}
const lockedCorrect = await call('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ activitySlug, classRef, studentRef: first.data.student.studentRef, accessCode: '2468' }) });
ensure(lockedCorrect.status === 423, 'Hồ sơ chưa giữ khóa 10 phút.');

const batch = await Promise.all(Array.from({ length: 40 }, (_, index) => register(index + 1)));
ensure(batch.every(item => item.status === 201), `Chỉ ${batch.filter(item => item.status === 201).length}/40 hồ sơ được tạo.`);
const openTarget = batch[0].data.student;
const opened = await call('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ activitySlug, classRef, studentRef: openTarget.studentRef, accessCode: '2468' }) });
ensure(opened.status === 201 && opened.data.session?.sessionRef, 'Mã đúng không mở được bài.');
const reopened = await call('/api/v1/sessions', { method: 'POST', body: JSON.stringify({ activitySlug, classRef, studentRef: openTarget.studentRef, accessCode: '2468' }) });
ensure(reopened.status === 201 && reopened.data.session.sessionRef === opened.data.session.sessionRef, 'Mở lại không giữ nguyên session.');

const refreshed = await call(`/api/v1/activities/${activitySlug}/roster`);
const temporary = refreshed.data.classes.flatMap(item => item.students).filter(item => item.provisional);
ensure(temporary.length >= 41 && temporary.every(item => item.requiresAccessCode), 'Roster thiếu cờ hồ sơ tạm/mã truy cập.');

console.log(JSON.stringify({ idempotent: true, duplicateProtected: true, lockedAfterFive: true, concurrentCreated: 40, reopenedSameSession: true, rosterProtected: true }));
