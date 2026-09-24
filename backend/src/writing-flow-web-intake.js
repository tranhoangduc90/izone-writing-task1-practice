import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { keyFromHex, seal, sha256 } from './writing-flow-crypto.js';
import { WEB_SUBSTITUTE_PROFILES } from './writing-flow-web-identity.js';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function requestIdentity(input) {
  const profile = WEB_SUBSTITUTE_PROFILES[input?.testSlug];
  if (!profile || !Number.isSafeInteger(Number(input?.classId))
    || Number(input.classId) <= 0 || typeof input.studentName !== 'string'
    || input.studentName.trim().length < 2 || input.studentName.length > 120) {
    throw new ApiError(400, 'WEB_ATTEMPT_REQUEST_INVALID',
      'Lớp, đề hoặc tên chọn chưa hợp lệ.');
  }
  return { profile, testSlug: input.testSlug, classId: Number(input.classId),
    studentName: input.studentName.normalize('NFKC').trim().replace(/\s+/gu, ' ') };
}

async function resolveStudent(client, identity, allowClosed = false) {
  let result;
  try {
    result = await client.query(`SELECT cohort,erp_course_class_id,
        erp_student_contact_id,rubric_version,accepting
      FROM writing_flow.resolve_web_substitute_student($1,$2,$3,$4)`,
    [identity.testSlug, identity.classId, identity.studentName, allowClosed]);
  } catch (error) {
    const code = String(error?.message || '').match(/WEB_(?:TEST_ACCESS_CLOSED|ROSTER_NAME_NOT_FOUND|ROSTER_NAME_AMBIGUOUS|ROSTER_INPUT_INVALID)/u)?.[0];
    if (code) throw new ApiError(code === 'WEB_ROSTER_NAME_AMBIGUOUS' ? 409
      : code === 'WEB_ROSTER_INPUT_INVALID' ? 400 : 404,
      code, 'Không thể xác định duy nhất học viên trong lớp/đề.');
    throw error;
  }
  const row = result.rows[0];
  if (result.rows.length !== 1 || Number(row.cohort) !== identity.profile.cohort
    || Number(row.erp_course_class_id) !== identity.classId
    || !Number.isSafeInteger(Number(row.erp_student_contact_id))) {
    throw new ApiError(409, 'WEB_ROSTER_IDENTITY_MISMATCH',
      'Học viên hoặc lớp không khớp roster đang mở.');
  }
  return { erpStudentId: Number(row.erp_student_contact_id),
    rubricVersion: row.rubric_version, accepting: row.accepting === true };
}

function publicAttempt(row) {
  return { attemptId: row.attempt_id, testSlug: row.test_slug,
    classId: Number(row.erp_course_class_id), taskNumber: Number(row.task_number),
    rubricVersion: row.rubric_version, status: row.status };
}

function pinnedPrompt(getPinnedPrompt, identity, taskNumber, rubricVersion) {
  // Chỉ dùng đề đã ghim trên máy chủ; không tin đề hoặc URL ảnh do trình duyệt gửi.
  const pinned = getPinnedPrompt({ testSlug: identity.testSlug,
    taskNumber, rubricVersion });
  const canonicalTopic = typeof pinned?.topic === 'string'
    ? pinned.topic.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
  if (!pinned || pinned.testSlug !== identity.testSlug
    || pinned.rubricVersion !== rubricVersion
    || pinned.taskNumber !== taskNumber
    || !canonicalTopic || canonicalTopic.length > 20_000
    || !SHA256.test(pinned.promptSha256)
    || sha256(canonicalTopic) !== pinned.promptSha256
    || (taskNumber === 1 && (!pinned.imageUrl
      || !/^https:\/\/ducizone\.ddns\.net\/writing-assets\//u.test(pinned.imageUrl)
      || !SHA256.test(pinned.imageSha256)))
    || (taskNumber === 2 && (pinned.imageUrl || pinned.imageSha256))) {
    throw new ApiError(503, 'WEB_PROMPT_PIN_MISMATCH',
      'Đề hoặc ảnh chưa khớp bản đã duyệt.');
  }
  return pinned;
}

// Dữ liệu vào: tên được chọn trong lớp/đề và roster có quyền mở trên DB.
// Việc chính: DB cấp hoặc tìm lại đúng lượt đầu tiên, khóa theo mã học viên ERP.
// Kết quả: mã lượt do máy chủ sinh, có thể mở lại bằng chọn cùng tên trên thiết bị khác.
// Khi lỗi: rollback và không lộ danh sách roster; tên không phải xác thực con người.
export function createWebSubstituteIntake({ pool, encryptionKey, getPinnedPrompt }) {
  const key = keyFromHex(encryptionKey);
  async function openAttempt(input) {
    if (!key || typeof getPinnedPrompt !== 'function') {
      throw new ApiError(503, 'WEB_INTAKE_NOT_READY', 'Nơi lưu bài web chưa sẵn sàng.');
    }
    const identity = requestIdentity(input);
    const attempt = await withTransaction(pool, async client => {
      const student = await resolveStudent(client, identity, true);
      const previous = await client.query(`SELECT *
        FROM writing_flow.web_substitute_attempt
        WHERE test_slug=$1 AND erp_course_class_id=$2
          AND erp_student_contact_id=$3 AND attempt_no=1 FOR UPDATE`,
      [identity.testSlug, identity.classId, student.erpStudentId]);
      if (!previous.rows.length && !student.accepting) {
        throw new ApiError(404, 'WEB_TEST_ACCESS_CLOSED',
          'Bài thi đã đóng nhận lượt mới.');
      }
      if (!previous.rows.length || previous.rows[0].status === 'open') {
        pinnedPrompt(getPinnedPrompt, identity, identity.profile.tasks[0],
          student.rubricVersion);
      }
      const inserted = previous.rows.length ? previous : await client.query(`INSERT INTO writing_flow.web_substitute_attempt
        (test_slug,cohort,erp_course_class_id,erp_student_contact_id,
         task_number,rubric_version)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (test_slug,erp_course_class_id,erp_student_contact_id,attempt_no)
        DO NOTHING RETURNING *`, [identity.testSlug, identity.profile.cohort,
        identity.classId, student.erpStudentId, identity.profile.tasks[0],
        student.rubricVersion]);
      const existing = inserted.rows[0] ? inserted : await client.query(`SELECT *
        FROM writing_flow.web_substitute_attempt
        WHERE test_slug=$1 AND erp_course_class_id=$2
          AND erp_student_contact_id=$3 AND attempt_no=1 FOR UPDATE`,
      [identity.testSlug, identity.classId, student.erpStudentId]);
      const row = existing.rows[0];
      if (!row || Number(row.task_number) !== identity.profile.tasks[0]) {
        throw new ApiError(409, 'WEB_ATTEMPT_IDENTITY_MISMATCH',
          'Lượt thi không khớp đề và Task.');
      }
      if (row.status === 'open' && row.rubric_version !== student.rubricVersion) {
        throw new ApiError(409, 'WEB_RUBRIC_VERSION_CHANGED',
          'Đề đã cập nhật; cần kiểm tra lượt chưa nộp.');
      }
      return publicAttempt(row);
    });
    const readback = await pool.query(`SELECT attempt_id FROM
      writing_flow.web_substitute_attempt WHERE attempt_id=$1`, [attempt.attemptId]);
    if (readback.rows.length !== 1) {
      throw new ApiError(503, 'WEB_ATTEMPT_READBACK_UNKNOWN',
        'Chưa xác nhận được lượt thi đã lưu.');
    }
    return attempt;
  }

  // Dữ liệu vào: mã lượt backend đã cấp và bài Writing; đề/ảnh lấy từ registry máy chủ.
  // Việc chính: mã hóa bài, lưu một phiếu nhận kiêm việc chờ đăng ký vào bộ chấm.
  // Kết quả: cùng lượt/Task/nội dung gửi lại nhận cùng phiếu; nội dung khác bị chặn.
  // Khi lỗi: không trả "đã nhận" nếu transaction hoặc đọc lại phiếu chưa xác nhận.
  async function submitWriting(input) {
    if (!key || typeof getPinnedPrompt !== 'function') {
      throw new ApiError(503, 'WEB_INTAKE_NOT_READY', 'Nơi lưu bài web chưa sẵn sàng.');
    }
    const identity = requestIdentity(input);
    const essay = String(input.essay ?? '');
    if (typeof input.essay !== 'string' || !essay.trim() || essay.length > 40_000
      || typeof input.attemptId !== 'string' || !UUID.test(input.attemptId)) {
      throw new ApiError(400, 'WEB_ESSAY_INVALID', 'Bài Writing chưa hợp lệ.');
    }
    if (input.taskNumber !== undefined
      && Number(input.taskNumber) !== identity.profile.tasks[0]) {
      throw new ApiError(409, 'WEB_TASK_MISMATCH', 'Task không khớp đề đã mở.');
    }
    const receipt = await withTransaction(pool, async client => {
      const student = await resolveStudent(client, identity, true);
      const found = await client.query(`SELECT * FROM writing_flow.web_substitute_attempt
        WHERE attempt_id=$1 FOR UPDATE`, [input.attemptId]);
      const attempt = found.rows[0];
      if (found.rows.length !== 1 || attempt.test_slug !== identity.testSlug
        || Number(attempt.cohort) !== identity.profile.cohort
        || Number(attempt.erp_course_class_id) !== identity.classId
        || Number(attempt.erp_student_contact_id) !== student.erpStudentId
        || Number(attempt.task_number) !== identity.profile.tasks[0]) {
        throw new ApiError(409, 'WEB_ATTEMPT_IDENTITY_MISMATCH',
          'Lượt thi không khớp lớp, học viên, đề hoặc Task.');
      }
      if (attempt.status === 'open' && attempt.rubric_version !== student.rubricVersion) {
        throw new ApiError(409, 'WEB_RUBRIC_VERSION_CHANGED',
          'Đề đã cập nhật; cần kiểm tra lượt chưa nộp.');
      }
      if (attempt.status === 'open' && !student.accepting) {
        throw new ApiError(409, 'WEB_TEST_ACCESS_CLOSED',
          'Bài thi đã đóng nhận bài mới.');
      }
      // Nguồn đề phải là cache/registry cục bộ đã ghim; không gọi mạng khi đang khóa lượt.
      const pinned = pinnedPrompt(getPinnedPrompt, identity,
        Number(attempt.task_number), attempt.rubric_version);
      const content = JSON.stringify({ taskNumber: pinned.taskNumber,
        topic: pinned.topic, imageUrl: pinned.imageUrl || '', essay });
      const contentSha256 = sha256(content);
      const inserted = await client.query(`INSERT INTO writing_flow.web_substitute_submission
        (attempt_id,task_number,content_ciphertext,content_sha256,
         prompt_sha256,image_sha256)
        VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT (attempt_id,task_number) DO NOTHING
        RETURNING submission_id,run_key,content_sha256,status`,
      [attempt.attempt_id, pinned.taskNumber, seal(content, key),
        contentSha256, pinned.promptSha256, pinned.imageSha256 || null]);
      const saved = inserted.rows[0] ? inserted : await client.query(`SELECT
        submission_id,run_key,content_sha256,status
        FROM writing_flow.web_substitute_submission
        WHERE attempt_id=$1 AND task_number=$2`,
      [attempt.attempt_id, pinned.taskNumber]);
      const row = saved.rows[0];
      if (!row || row.content_sha256.trim() !== contentSha256) {
        throw new ApiError(409, 'WEB_SUBMISSION_CONFLICT',
          'Lượt này đã nhận một bài Writing khác.');
      }
      await client.query(`UPDATE writing_flow.web_substitute_attempt
        SET status='submitted',updated_at=now()
        WHERE attempt_id=$1 AND status='open'`, [attempt.attempt_id]);
      return { submissionId: row.submission_id, attemptId: attempt.attempt_id,
        taskNumber: pinned.taskNumber, runKey: row.run_key, status: row.status };
    });
    const readback = await pool.query(`SELECT submission_id,attempt_id,task_number,
      run_key,status FROM writing_flow.web_substitute_submission
      WHERE submission_id=$1`, [receipt.submissionId]);
    const row = readback.rows[0];
    if (readback.rows.length !== 1 || row.attempt_id !== receipt.attemptId
      || Number(row.task_number) !== receipt.taskNumber || row.run_key !== receipt.runKey) {
      throw new ApiError(503, 'WEB_RECEIPT_READBACK_UNKNOWN',
        'Chưa xác nhận được phiếu nhận bài.');
    }
    return { submissionId: receipt.submissionId, attemptId: receipt.attemptId,
      taskNumber: receipt.taskNumber, status: row.status };
  }

  return { openAttempt, submitWriting };
}
