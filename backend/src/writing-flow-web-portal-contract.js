import { ApiError } from './service.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function validBand(value) {
  return typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= 9 && Number.isInteger(value * 10);
}

function validRawSection(section) {
  return section?.total === 40 && Number.isInteger(section.correct)
    && section.correct >= 0 && section.correct <= 40;
}

// Dữ liệu vào: phiếu backend đã chấm xong cùng điểm Nghe, Đọc và Writing đã lưu.
// Việc chính: khóa đúng đề/lớp/Task/học viên, rồi dựng hợp đồng của bộ ghi Portal cũ.
// Kết quả: mặc định chỉ xem trước; ghi thật phải được yêu cầu bằng commit=true rõ ràng.
// Khi lỗi: dừng trước mọi lời gọi Portal, không tự suy lớp hoặc điểm còn thiếu.
export function buildSubstitutePortalRequest(receipt, { commit = false } = {}) {
  if (typeof commit !== 'boolean') {
    throw new ApiError(400, 'SUBSTITUTE_PORTAL_COMMIT_INVALID',
      'Chế độ ghi điểm Portal không hợp lệ.');
  }
  if (!receipt || receipt.testSlug !== 'substitute-test-2-k56'
    || receipt.classId !== 1252
    || (receipt.classCode && receipt.classCode !== 'IC2264')
    || !Number.isSafeInteger(receipt.erpStudentId) || receipt.erpStudentId < 1
    || receipt.taskNumber !== 1 || receipt.submissionStatus !== 'completed'
    || !UUID.test(String(receipt.submissionId || ''))
    || !UUID.test(String(receipt.attemptId || ''))) {
    throw new ApiError(409, 'SUBSTITUTE_PORTAL_TARGET_INVALID',
      'Phiếu không khớp đề, lớp, học viên, lượt hoặc chưa hoàn tất.');
  }
  const grades = {
    listening: receipt.sectionResults?.listening?.correct,
    reading: receipt.sectionResults?.reading?.correct,
    writing: receipt.taskScore,
  };
  if (!validRawSection(receipt.sectionResults?.listening)
    || !validRawSection(receipt.sectionResults?.reading)
    || !validBand(grades.writing)) {
    throw new ApiError(409, 'SUBSTITUTE_PORTAL_GRADES_INVALID',
      'Phiếu chưa có đủ ba điểm hợp lệ để ghi Portal.');
  }
  return {
    version: 1, testSlug: receipt.testSlug, classCode: 'IC2264',
    classId: receipt.classId, studentId: receipt.erpStudentId,
    attemptToken: receipt.attemptId, grades, commit,
  };
}
