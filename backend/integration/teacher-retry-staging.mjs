// Dữ liệu nhận vào: UUID công khai của một lượt chấm lỗi trong database staging hoàn toàn giả.
// Việc chính: gọi đúng service production để giảng viên xếp lại cùng lượt chấm và chạy lại lần hai để kiểm tra idempotency.
// Kết quả: lượt đầu chuyển sang queued, lượt hai trả lại cùng attempt; script không in nội dung bài hoặc danh tính.
// Khi lỗi: transaction service rollback và process trả exit code khác 0 để cổng phát hành dừng lại.
import { loadConfig } from "file:///app/src/config.js";
import { createDatabasePool } from "file:///app/src/db.js";
import { createLessonPracticeService } from "file:///app/src/lesson-service.js";

const attemptRef = process.argv[2];
if (!attemptRef) throw new Error("Thiếu attemptRef staging.");

const pool = createDatabasePool(loadConfig());
try {
  const service = createLessonPracticeService({ pool });
  const first = await service.retryFailedAttempt({ attemptRef, actorRef: "staging-release-check" });
  const second = await service.retryFailedAttempt({ attemptRef, actorRef: "staging-release-check" });
  if (first.status !== "queued" || first.idempotent !== false) throw new Error("Lượt đầu không được xếp queued đúng cách.");
  if (!second.idempotent || second.attemptRef !== first.attemptRef) throw new Error("Lượt hai không idempotent.");
  const verification = await pool.query(`SELECT attempt.status,attempt.retry_count,comment.status AS comment_status,
    comment.content,section.fail_streak,
    (SELECT count(*) FROM writing_practice.admin_audit_event audit
      WHERE audit.session_id=attempt.session_id AND audit.section_key=attempt.section_key
        AND audit.action='retry_failed_attempt')::int AS audit_count
    FROM writing_practice.check_attempt attempt
    JOIN writing_practice.comment comment ON comment.attempt_id=attempt.id
    JOIN writing_practice.session_section section ON section.session_id=attempt.session_id
      AND section.section_key=attempt.section_key
    WHERE attempt.public_id=$1`, [attemptRef]);
  const row = verification.rows[0];
  if (!row || row.status !== "queued" || row.retry_count !== 0 || row.comment_status !== "queued" || row.content !== "Đang chấm" || row.audit_count !== 1) {
    throw new Error("Readback staging không khớp hợp đồng khôi phục.");
  }
  process.stdout.write(JSON.stringify({ ok: true, sameAttempt: true, sameComment: true, idempotent: true, failStreakUnchanged: true, auditCount: row.audit_count }));
} finally {
  await pool.end();
}
