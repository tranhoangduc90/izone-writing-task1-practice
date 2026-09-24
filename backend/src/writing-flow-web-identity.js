import { ApiError } from './service.js';

// Dữ liệu vào: mã đề của trang thi đã đối chiếu với bản Pages đang phát hành.
// Việc chính: khóa đúng khóa học và Task Writing mà trang đó thực sự mở.
// Kết quả: bộ nhận bài web không tự suy Task từ ảnh hoặc tên workflow.
// Khi lỗi: từ chối trước khi lưu bài; không gọi bộ chấm.
export const WEB_SUBSTITUTE_PROFILES = Object.freeze({
  'substitute-test-1-k56': Object.freeze({ cohort: 56, tasks: Object.freeze([2]) }),
  'substitute-test-2-k56': Object.freeze({ cohort: 56, tasks: Object.freeze([1]) }),
  'substitute-test-1-k67': Object.freeze({ cohort: 67, tasks: Object.freeze([2]) }),
  'substitute-test-2-k67': Object.freeze({ cohort: 67, tasks: Object.freeze([2]) }),
});

function validPositiveId(value) {
  return Number.isSafeInteger(Number(value)) && Number(value) > 0;
}

function sameNumber(left, right) {
  return validPositiveId(left) && validPositiveId(right)
    && Number(left) === Number(right);
}

function sameText(left, right) {
  return typeof left === 'string' && left.length > 0 && left === right;
}

function normalizedName(value) {
  return String(value ?? '').normalize('NFKC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('vi');
}

// Dữ liệu vào: roster của đúng lớp đọc từ database và tên học viên đã chọn trên web.
// Việc chính: chỉ chọn khi tên khớp duy nhất; không coi tên là mật khẩu.
// Kết quả: trả mã học viên ổn định để tìm lại lượt trên thiết bị khác.
// Khi lỗi: tên trùng hoặc không có trong lớp chuyển sang cần hỗ trợ, không chọn đại.
export function findNamedRosterStudent({ rosterRows, classId, selectedName }) {
  const name = normalizedName(selectedName);
  const matches = Array.isArray(rosterRows) && name
    ? rosterRows.filter(row => sameNumber(row.classId, classId)
      && row.eligible === true && normalizedName(row.studentName) === name)
    : [];
  if (matches.length !== 1 || !validPositiveId(matches[0].erpStudentId)) {
    throw new ApiError(409, matches.length > 1 ? 'ROSTER_NAME_AMBIGUOUS' : 'ROSTER_NAME_NOT_FOUND',
      'Không thể xác định duy nhất học viên trong lớp.');
  }
  return Object.freeze({
    classId: Number(matches[0].classId), erpStudentId: Number(matches[0].erpStudentId),
    eligible: true,
  });
}

// Dữ liệu vào: phiếu lượt do backend đã lưu, dòng roster đã đọc từ database,
// và yêu cầu nhận bài/trạng thái/callback. Tên học viên không phải bằng chứng xác thực.
// Việc chính: đối chiếu toàn bộ khóa nguồn–lớp–học viên–lượt–Task–rubric.
// Kết quả: trả định danh chuẩn từ database, không từ trường do trình duyệt tự khai.
// Khi lỗi: trả mã lỗi cố định, không đưa tên/bài viết vào log hay phản hồi.
export function bindWebSubstituteAttempt({ stored, roster, request }) {
  const profile = WEB_SUBSTITUTE_PROFILES[stored?.testSlug];
  if (!profile || !roster || !request) {
    throw new ApiError(409, 'WEB_ATTEMPT_NOT_FOUND', 'Không tìm thấy lượt thi hợp lệ.');
  }
  if (stored.source !== 'substitute_web'
    || !sameNumber(stored.cohort, profile.cohort)
    || !sameText(stored.testSlug, request.testSlug)
    || !sameText(stored.attemptId, request.attemptId)
    || !sameNumber(stored.classId, request.classId)
    || !sameNumber(stored.classId, roster.classId)
    || !sameNumber(stored.erpStudentId, request.erpStudentId)
    || !sameNumber(stored.erpStudentId, roster.erpStudentId)
    || roster.eligible !== true
    || !sameNumber(request.taskNumber, stored.taskNumber)
    || !profile.tasks.includes(Number(stored.taskNumber))
    || !sameText(stored.rubricVersion, request.rubricVersion)
    || !sameText(stored.runKey, request.runKey)) {
    throw new ApiError(409, 'WEB_ATTEMPT_IDENTITY_MISMATCH',
      'Lượt thi, lớp, học viên hoặc Task không khớp bản đã lưu.');
  }
  return Object.freeze({
    source: stored.source,
    cohort: profile.cohort,
    classId: Number(stored.classId),
    erpStudentId: Number(stored.erpStudentId),
    testSlug: stored.testSlug,
    attemptId: stored.attemptId,
    taskNumber: Number(stored.taskNumber),
    rubricVersion: stored.rubricVersion,
    runKey: stored.runKey,
  });
}
