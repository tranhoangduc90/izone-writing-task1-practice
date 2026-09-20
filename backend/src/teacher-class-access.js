import { ApiError } from './service.js';
import { reviewerClassAccessSql } from './teacher-class-access-sql.js';

export function reviewerIsAdmin(reviewer) {
  return reviewer?.role === 'admin';
}

function denied() {
  return new ApiError(403, 'CLASS_ACCESS_DENIED', 'Tài khoản chưa được phân công phụ trách lớp này.');
}

// Dữ liệu nhận vào: tài khoản giảng viên đã xác minh và khóa ổn định của lớp/phiên/comment.
// Việc chính: ghép qua erp_course_class_id với bảng phân công; chỉ role=admin được bỏ qua giới hạn lớp.
// Kết quả: trả danh sách lớp được phép hoặc cho route tiếp tục khi đúng phạm vi.
// Khi không khớp: trả 403 chung, không trả dữ liệu của lớp hay học viên ngoài phạm vi.
export function createTeacherClassAccessService({ pool }) {
  async function listClasses(reviewer) {
    const result = await pool.query(`SELECT DISTINCT scope.class_name_snapshot AS "classCode"
      FROM writing_practice.activity_class_scope scope
      WHERE scope.status='active' AND scope.end_date>=CURRENT_DATE
        AND ($1::boolean OR ${reviewerClassAccessSql('scope', '$2')})
      ORDER BY scope.class_name_snapshot`, [reviewerIsAdmin(reviewer), reviewer.email]);
    return result.rows.map(row => ({ classCode: row.classCode }));
  }

  async function assertQuery(reviewer, sql, reference, extraParams = []) {
    if (reviewerIsAdmin(reviewer)) return;
    const result = await pool.query(sql, [reference, reviewer.email, ...extraParams]);
    if (result.rowCount !== 1) throw denied();
  }

  async function assertActivityClass(reviewer, { activitySlug, classRef }) {
    return assertQuery(reviewer, `SELECT 1
      FROM writing_practice.activity_class_scope scope
      JOIN writing_practice.activity activity ON activity.id=scope.activity_id
      WHERE scope.public_id=$1 AND activity.slug=$3
        AND scope.status='active' AND scope.end_date>=CURRENT_DATE
        AND ${reviewerClassAccessSql('scope', '$2')}
      LIMIT 1`, classRef, [activitySlug]);
  }

  async function assertSession(reviewer, sessionRef) {
    return assertQuery(reviewer, `SELECT 1
      FROM writing_practice.activity_session session
      JOIN writing_practice.activity_class_scope scope ON scope.id=session.activity_class_id
      WHERE session.public_id=$1 AND ${reviewerClassAccessSql('scope', '$2')}
      LIMIT 1`, sessionRef);
  }

  async function assertAttempt(reviewer, attemptRef) {
    return assertQuery(reviewer, `SELECT 1
      FROM writing_practice.check_attempt attempt
      JOIN writing_practice.activity_session session ON session.id=attempt.session_id
      JOIN writing_practice.activity_class_scope scope ON scope.id=session.activity_class_id
      WHERE attempt.public_id=$1 AND ${reviewerClassAccessSql('scope', '$2')}
      LIMIT 1`, attemptRef);
  }

  async function assertProvisionalStudent(reviewer, studentRef) {
    return assertQuery(reviewer, `SELECT 1
      FROM writing_practice.provisional_student student
      JOIN writing_practice.activity_class_scope scope ON scope.id=student.activity_class_id
      WHERE student.student_public_id=$1 AND ${reviewerClassAccessSql('scope', '$2')}
      LIMIT 1`, studentRef);
  }

  async function assertCommentThread(reviewer, threadRef) {
    return assertQuery(reviewer, `SELECT 1
      FROM writing_practice.teacher_comment_thread thread
      JOIN writing_practice.activity_session session ON session.id=thread.session_id
      JOIN writing_practice.activity_class_scope scope ON scope.id=session.activity_class_id
      WHERE thread.public_id=$1 AND ${reviewerClassAccessSql('scope', '$2')}
      LIMIT 1`, threadRef);
  }

  return { listClasses, assertActivityClass, assertSession, assertAttempt, assertProvisionalStudent, assertCommentThread };
}
