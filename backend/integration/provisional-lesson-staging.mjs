// Dữ liệu nhận vào: Lesson 13 staging và một hồ sơ hoàn toàn giả.
// Việc chính: đăng ký tạm, mở bài bằng mã, lưu một ô và mở lại đúng session.
// Kết quả: chỉ in cờ tổng hợp; không in tên, mã, UUID hay bài viết.
const baseUrl = String(process.env.API_BASE_URL || '').replace(/\/$/, '');
const activitySlug = 'writing-lesson13-young-leaders';
function ensure(value, message) { if (!value) throw new Error(message); }
async function call(path, options = {}) { const response = await fetch(`${baseUrl}${path}`, { ...options, headers: { ...(options.body ? { 'content-type': 'application/json' } : {}) } }); const data = await response.json().catch(() => ({})); return { status: response.status, data }; }

const roster = await call(`/api/v1/activities/${activitySlug}/roster`);
ensure(roster.status === 200 && roster.data.classes?.[0], 'Lesson 13 staging chưa có lớp.');
const classRef = roster.data.classes[0].classRef;
const created = await call(`/api/v1/activities/${activitySlug}/provisional-students`, { method: 'POST', body: JSON.stringify({ classRef, displayName: 'ZZ Kiểm thử tạm Lesson 13', pin: '2468', requestId: crypto.randomUUID() }) });
ensure(created.status === 201, 'Không tạo được hồ sơ tạm Lesson 13.');
const studentRef = created.data.student.studentRef;
const opened = await call('/api/v1/lesson-sessions', { method: 'POST', body: JSON.stringify({ activitySlug, classRef, studentRef, accessCode: '2468' }) });
ensure(opened.status === 201, 'Không mở được Lesson 13 bằng mã đúng.');
const session = opened.data.session;
const field = session.sectionDefinitions?.[0]?.inputFields?.[0];
ensure(field, 'Lesson 13 thiếu định nghĩa ô viết.');
const saved = await call(`/api/v1/lesson-sessions/${session.sessionRef}/responses`, { method: 'PUT', body: JSON.stringify({ baseVersion: session.draftVersion, requestId: crypto.randomUUID(), responses: { [field]: 'Nội dung giả.' } }) });
ensure(saved.status === 200, 'Không lưu được Lesson 13.');
const reopened = await call('/api/v1/lesson-sessions', { method: 'POST', body: JSON.stringify({ activitySlug, classRef, studentRef, accessCode: '2468' }) });
ensure(reopened.status === 201 && reopened.data.session.sessionRef === session.sessionRef && reopened.data.session.responses[field] === 'Nội dung giả.', 'Mở lại Lesson 13 không giữ tiến trình.');
console.log(JSON.stringify({ lesson13ProvisionalOpened: true, lesson13Saved: true, lesson13Reopened: true }));
