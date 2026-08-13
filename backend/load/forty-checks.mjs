// Dữ liệu nhận vào: URL API và mã hoạt động công khai qua biến môi trường.
// Việc chính: lấy tối đa 40 học viên từ roster, mở phiên, dồn 40 lượt lưu/Check;
// đồng thời gửi 20 Check cho cùng một học viên để kiểm tra chống tạo trùng.
// Kết quả: chỉ in mã HTTP và số attemptRef khác nhau, không in tên hay bài làm.
const baseUrl = String(process.env.API_BASE_URL || '').replace(/\/$/, '');
const activitySlug = process.env.ACTIVITY_SLUG;
if (!baseUrl || !activitySlug) throw new Error('Cần API_BASE_URL và ACTIVITY_SLUG.');

async function request(path, options) {
  const response = await fetch(`${baseUrl}${path}`, options);
  const value = await response.json().catch(() => ({}));
  return { status: response.status, value };
}

const rosterResponse = await request(`/api/v1/activities/${encodeURIComponent(activitySlug)}/roster`);
if (rosterResponse.status !== 200) throw new Error(`Không tải được roster: HTTP ${rosterResponse.status}`);
const students = (rosterResponse.value.classes || [])
  .flatMap((group) => (group.students || []).map((student) => ({ classRef: group.classRef, studentRef: student.studentRef })))
  .slice(0, 40);
if (students.length < 40) throw new Error(`Cần ít nhất 40 học viên công khai; hiện có ${students.length}.`);

const opened = await Promise.all(students.map(({ classRef, studentRef }) => request('/api/v1/sessions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ activitySlug, classRef, studentRef, requestId: crypto.randomUUID() })
})));
if (opened.some((item) => item.status !== 201)) throw new Error('Có phiên học viên không mở được.');
const sessions = opened.map((item) => item.value.session);

const duplicateSnapshot = { overview: 'Load test idempotency sample.', body1: '', body2: '' };
const rapidChecks = await Promise.all(Array.from({ length: 20 }, () => request(`/api/v1/sessions/${sessions[0].sessionRef}/checks`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ requestId: crypto.randomUUID(), section: 'overview', snapshot: duplicateSnapshot })
})));
const rapidAttemptRefs = new Set(rapidChecks.map((item) => item.value?.attempt?.attemptRef).filter(Boolean));

const burst = await Promise.all(sessions.flatMap((session, index) => {
  const snapshot = { overview: `Load test sample ${index + 1}.`, body1: '', body2: '' };
  return [
    request(`/api/v1/sessions/${session.sessionRef}/draft`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), baseVersion: session.draftVersion, ...snapshot })
    }),
    request(`/api/v1/sessions/${session.sessionRef}/checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ requestId: crypto.randomUUID(), section: 'overview', snapshot })
    })
  ];
}));

const responseCodes = [...rapidChecks, ...burst].reduce((all, item) => ({ ...all, [item.status]: (all[item.status] ?? 0) + 1 }), {});
process.stdout.write(`${JSON.stringify({ students: sessions.length, requests: rapidChecks.length + burst.length, responseCodes, rapidAttemptRefCount: rapidAttemptRefs.size })}\n`);
if (rapidAttemptRefs.size !== 1) throw new Error(`Idempotency lỗi: 20 Check tạo ${rapidAttemptRefs.size} attemptRef.`);
