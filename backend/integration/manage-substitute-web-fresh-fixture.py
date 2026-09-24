"""Thêm/gỡ đúng một học viên giả để thử lượt web mới trong Writing staging."""

import argparse
import json
import re
import shlex
import sys

import paramiko
import win32cred


TARGET_CONTACT_ID = 990056102
BACKUP_PATTERN = (
    r"/opt/backups/writing-practice/substitute-canary-\d{8}T\d{6}Z/"
    r"writing-practice-staging-before-substitute\.dump"
)

INSPECT_SQL = """BEGIN READ ONLY;
SELECT current_database(),
  (SELECT count(*)::int FROM assessment_k56.term_test_roster
   WHERE erp_student_contact_id=990056102),
  (SELECT count(*)::int FROM writing_flow.web_substitute_attempt
   WHERE erp_student_contact_id=990056102),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission AS s
   JOIN writing_flow.web_substitute_attempt AS a USING (attempt_id)
   WHERE a.erp_student_contact_id=990056102),
  (SELECT count(*)::int FROM writing_flow.web_substitute_portal_outbox AS o
   JOIN writing_flow.web_substitute_submission AS s USING (submission_id)
   JOIN writing_flow.web_substitute_attempt AS a USING (attempt_id)
   WHERE a.erp_student_contact_id=990056102),
  (SELECT count(*)::int FROM assessment_k56.term_test_roster
   WHERE erp_course_class_id=990056001
     AND erp_student_contact_id=990056101
     AND student_name_snapshot='Học viên giả khóa 56'),
  (SELECT count(*)::int FROM writing_flow.web_substitute_access
   WHERE test_slug='substitute-test-2-k56'
     AND erp_course_class_id=990056001 AND enabled),
  (SELECT count(*)::int FROM writing_flow.web_substitute_attempt),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission
   WHERE status='running'),
  (SELECT count(*)::int FROM pg_constraint
   WHERE contype='f' AND confrelid='writing_flow.web_substitute_attempt'::regclass),
  (SELECT count(*)::int FROM pg_constraint
   WHERE contype='f' AND confrelid='writing_flow.web_substitute_submission'::regclass);
COMMIT;
"""

APPLY_SQL = """-- Dữ liệu vào: đúng một lớp và học viên giả trong database staging.
-- Việc chính: chặn mọi lệch baseline, rồi thêm một roster giả trong transaction.
-- Kết quả: có một tên mới để thử nộp bài web lần đầu.
-- Khi lỗi: rollback transaction, không sửa bài hay lớp thật.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $lock$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('substitute_web_fresh_canary_20260925'));
END; $lock$;
DO $guard$
BEGIN
  IF current_database()<>'writing_practice_staging'
    OR (SELECT count(*) FROM assessment_k56.term_test_roster)<>1
    OR (SELECT count(*) FROM writing_flow.web_substitute_attempt)<>4
    OR (SELECT count(*) FROM writing_flow.web_substitute_submission)<>4
    OR EXISTS (SELECT 1 FROM writing_flow.web_substitute_submission
               WHERE status='running')
    OR (SELECT count(*) FROM assessment_k56.term_test_roster
        WHERE erp_course_class_id=990056001
          AND erp_student_contact_id=990056101
          AND student_name_snapshot='Học viên giả khóa 56')<>1
    OR (SELECT count(*) FROM writing_flow.web_substitute_access
        WHERE test_slug='substitute-test-2-k56'
          AND erp_course_class_id=990056001 AND enabled)<>1
    OR EXISTS (SELECT 1 FROM assessment_k56.term_test_roster
               WHERE erp_student_contact_id=990056102
                  OR student_name_snapshot='Học viên giả web khóa 56')
    OR EXISTS (SELECT 1 FROM writing_flow.web_substitute_attempt
               WHERE erp_student_contact_id=990056102) THEN
    RAISE EXCEPTION 'WEB_FRESH_CANARY_APPLY_SCOPE_MISMATCH';
  END IF;
END;
$guard$;
INSERT INTO assessment_k56.term_test_roster
  (test_slug, erp_course_class_id, erp_student_contact_id,
   student_ref, student_name_snapshot, is_eligible)
VALUES ('term-test-1-k56', 990056001, 990056102,
        '56000000-0000-4000-8000-000000000002',
        'Học viên giả web khóa 56', true);
COMMIT;
SELECT current_database(),
  (SELECT count(*)::int FROM assessment_k56.term_test_roster
   WHERE erp_student_contact_id=990056102),
  (SELECT count(*)::int FROM writing_flow.web_substitute_attempt),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission);
"""

ROLLBACK_SQL = """-- Dữ liệu vào: chỉ phiếu của học viên giả web đã chấm xong trong staging.
-- Việc chính: khóa đúng ID và trạng thái, gỡ outbox → bài → lượt → roster.
-- Kết quả: trở lại bốn bài giả baseline, không đổi dữ liệu khác.
-- Khi lỗi: rollback transaction, giữ phiếu để điều tra.
BEGIN;
SET LOCAL lock_timeout='5s';
DO $lock$ BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('substitute_web_fresh_canary_20260925'));
END; $lock$;
DO $guard$
BEGIN
  IF current_database()<>'writing_practice_staging'
    OR (SELECT count(*) FROM assessment_k56.term_test_roster)<>2
    OR (SELECT count(*) FROM assessment_k56.term_test_roster
        WHERE test_slug='term-test-1-k56'
          AND erp_course_class_id=990056001
          AND erp_student_contact_id=990056102
          AND student_ref='56000000-0000-4000-8000-000000000002'::uuid
          AND student_name_snapshot='Học viên giả web khóa 56'
          AND is_eligible)<>1
    OR (SELECT count(*) FROM writing_flow.web_substitute_attempt)<>5
    OR (SELECT count(*) FROM writing_flow.web_substitute_submission)<>5
    OR (SELECT count(*) FROM writing_flow.web_substitute_attempt
        WHERE test_slug='substitute-test-2-k56'
          AND erp_course_class_id=990056001
          AND erp_student_contact_id=990056102
          AND task_number=1)<>1
    OR (SELECT count(*) FROM writing_flow.web_substitute_submission AS s
        JOIN writing_flow.web_substitute_attempt AS a USING (attempt_id)
        WHERE a.erp_student_contact_id=990056102
          AND s.status='completed')<>1
    OR EXISTS (SELECT 1 FROM writing_flow.web_substitute_portal_outbox AS o
               JOIN writing_flow.web_substitute_submission AS s USING (submission_id)
               JOIN writing_flow.web_substitute_attempt AS a USING (attempt_id)
               WHERE a.erp_student_contact_id=990056102)
    OR EXISTS (SELECT 1 FROM writing_flow.web_substitute_submission
               WHERE status='running')
    OR (SELECT count(*) FROM pg_constraint
        WHERE contype='f'
          AND confrelid='writing_flow.web_substitute_attempt'::regclass)<>1
    OR (SELECT count(*) FROM pg_constraint
        WHERE contype='f'
          AND confrelid='writing_flow.web_substitute_submission'::regclass)<>1 THEN
    RAISE EXCEPTION 'WEB_FRESH_CANARY_ROLLBACK_SCOPE_MISMATCH';
  END IF;
END;
$guard$;
DELETE FROM writing_flow.web_substitute_submission AS s
USING writing_flow.web_substitute_attempt AS a
WHERE s.attempt_id=a.attempt_id
  AND a.test_slug='substitute-test-2-k56'
  AND a.erp_course_class_id=990056001
  AND a.erp_student_contact_id=990056102;
DELETE FROM writing_flow.web_substitute_attempt
WHERE test_slug='substitute-test-2-k56'
  AND erp_course_class_id=990056001
  AND erp_student_contact_id=990056102;
DELETE FROM assessment_k56.term_test_roster
WHERE test_slug='term-test-1-k56'
  AND erp_course_class_id=990056001
  AND erp_student_contact_id=990056102
  AND student_ref='56000000-0000-4000-8000-000000000002'::uuid;
COMMIT;
SELECT current_database(),
  (SELECT count(*)::int FROM assessment_k56.term_test_roster),
  (SELECT count(*)::int FROM writing_flow.web_substitute_attempt),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission),
  (SELECT count(*)::int FROM writing_flow.web_substitute_portal_outbox);
"""


def remote(client, command, stdin_text=None, timeout=45):
    # Dữ liệu vào: lệnh chỉ tới database staging hoặc bản backup đã chỉ rõ.
    # Việc chính: đọc hết output, giữ exit code gốc và không in secret/SQL.
    # Kết quả: một dòng đếm; khi lỗi báo mã bước, không tự retry.
    stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    if stdin_text is not None:
        stdin.write(stdin_text)
        stdin.channel.shutdown_write()
    value = stdout.read().decode("utf-8", errors="replace").strip()
    stderr.read()
    if stdout.channel.recv_exit_status():
        raise RuntimeError("WEB_FRESH_CANARY_REMOTE_COMMAND_FAILED")
    return value


def psql(client, sql):
    command = ("docker exec -i mapping-postgres sh -lc 'psql -X -q "
               "-v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" "
               "-d writing_practice_staging -At -F \"|\"'")
    return remote(client, command, sql)


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--inspect", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--rollback", action="store_true")
    parser.add_argument("--backup")
    parser.add_argument("--sha256")
    args = parser.parse_args()
    if not args.inspect and (
        not args.backup or not re.fullmatch(BACKUP_PATTERN, args.backup)
        or not args.sha256 or not re.fullmatch(r"[0-9a-f]{64}", args.sha256)
    ):
        raise RuntimeError("WEB_FRESH_CANARY_BACKUP_IDENTITY_INVALID")
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = (credential.get("UserName") or "root").strip().split("@", 1)[0]
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    step = "connect"
    try:
        client.connect("ducizone.ddns.net", port=22, username=username,
                       password=password, timeout=15)
        if args.inspect:
            step = "inspect"
            values = psql(client, INSPECT_SQL).splitlines()
            if len(values) != 1:
                raise RuntimeError("WEB_FRESH_CANARY_INSPECT_FORMAT_INVALID")
            fields = values[0].split("|")
            if len(fields) != 12 or fields[0] != "writing_practice_staging":
                raise RuntimeError("WEB_FRESH_CANARY_INSPECT_SCOPE_INVALID")
            labels = ("targetRoster", "targetAttempts", "targetSubmissions",
                      "targetPortalOutbox", "originalRoster", "accessPairs",
                      "allAttempts", "allSubmissions", "runningSubmissions",
                      "attemptReferencingFks", "submissionReferencingFks")
            print(json.dumps({"toolOutcome": "success", "businessOutcome": "inventory",
                              "database": fields[0],
                              **dict(zip(labels, map(int, fields[1:]))),
                              "productionWrites": 0}, ensure_ascii=False))
            return 0
        step = "verify_backup"
        digest = remote(client, "sha256sum -- " + shlex.quote(args.backup)).split(" ", 1)[0]
        if digest != args.sha256:
            raise RuntimeError("WEB_FRESH_CANARY_BACKUP_HASH_MISMATCH")
        remote(client, "docker exec -i mapping-postgres pg_restore -l < "
               + shlex.quote(args.backup) + " > /dev/null")
        step = "apply" if args.apply else "rollback"
        result = psql(client, APPLY_SQL if args.apply else ROLLBACK_SQL).splitlines()
        expected = (["writing_practice_staging|1|4|4"] if args.apply
                    else ["writing_practice_staging|1|4|4|0"])
        if result != expected:
            raise RuntimeError("WEB_FRESH_CANARY_MUTATION_READBACK_MISMATCH")
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "verified",
                          "operation": step, "database": "writing_practice_staging",
                          "targetContactId": TARGET_CONTACT_ID,
                          "readbackMatched": True, "productionWrites": 0},
                         ensure_ascii=False))
        return 0
    except (paramiko.SSHException, OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"toolOutcome": "failure", "businessOutcome":
                          "partial" if step in ("apply", "rollback") else "unknown",
                          "step": step, "errorType": type(error).__name__}),
              file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
