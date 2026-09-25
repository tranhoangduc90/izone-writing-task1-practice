"""Mở/gỡ lớp IC2264 giả trong kho staging để kiểm trình duyệt với cổng thật."""

import argparse
import json
import re
import shlex
import sys

import paramiko
import win32cred


BACKUP_PATTERN = (
    r"/opt/backups/writing-practice/substitute-canary-\d{8}T\d{6}Z/"
    r"writing-practice-staging-before-substitute\.dump"
)

COUNTS_SQL = """BEGIN READ ONLY;
SELECT current_database(),
  (SELECT count(*)::int FROM assessment_k56.term_test_roster),
  (SELECT count(*)::int FROM writing_flow.web_substitute_access),
  (SELECT count(*)::int FROM writing_flow.web_substitute_attempt),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission),
  (SELECT count(*)::int FROM writing_flow.web_substitute_portal_outbox),
  (SELECT count(*)::int FROM assessment_k56.term_test_roster
   WHERE test_slug='term-test-1-k56' AND erp_course_class_id=1252
     AND erp_student_contact_id=990056102
     AND student_ref='56000000-0000-4000-8000-000000000002'::uuid
     AND student_name_snapshot='Học viên giả web khóa 56' AND is_eligible),
  (SELECT count(*)::int FROM writing_flow.web_substitute_access
   WHERE test_slug='substitute-test-2-k56' AND erp_course_class_id=1252
     AND rubric_version='substitute-test2-k56-isolated-20260917-v1'
     AND enabled AND source='staging_fixture'),
  (SELECT count(*)::int FROM writing_flow.web_substitute_attempt
   WHERE test_slug='substitute-test-2-k56' AND erp_course_class_id=1252
     AND erp_student_contact_id=990056102),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission AS s
   JOIN writing_flow.web_substitute_attempt AS a USING (attempt_id)
   WHERE a.test_slug='substitute-test-2-k56' AND a.erp_course_class_id=1252
     AND a.erp_student_contact_id=990056102),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission AS s
   JOIN writing_flow.web_substitute_attempt AS a USING (attempt_id)
   WHERE a.erp_course_class_id=1252 AND a.erp_student_contact_id=990056102
     AND s.status='completed');
COMMIT;
"""

APPLY_SQL = """-- Dữ liệu vào: kho staging đúng mốc bốn bài giả, bản sao lưu đã kiểm hash.
-- Việc chính: thêm đúng một học viên và một quyền đề cho lớp IC2264 giả.
-- Kết quả: cổng thử có thể cấp phiếu với classId=1252 như trang web thật.
-- Khi lỗi: transaction rollback, không đổi lớp hoặc điểm production.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtext('substitute_browser_class_canary_20260925'));
DO $guard$ BEGIN
  IF current_database()<>'writing_practice_staging'
    OR (SELECT count(*) FROM assessment_k56.term_test_roster)<>1
    OR (SELECT count(*) FROM writing_flow.web_substitute_access)<>4
    OR (SELECT count(*) FROM writing_flow.web_substitute_attempt)<>4
    OR (SELECT count(*) FROM writing_flow.web_substitute_submission)<>4
    OR EXISTS (SELECT 1 FROM writing_flow.web_substitute_submission
               WHERE status IN ('pending','running','needs_review'))
    OR EXISTS (SELECT 1 FROM writing_flow.web_substitute_portal_outbox)
    OR EXISTS (SELECT 1 FROM assessment_k56.term_test_roster
               WHERE erp_course_class_id=1252 OR erp_student_contact_id=990056102)
    OR EXISTS (SELECT 1 FROM writing_flow.web_substitute_access
               WHERE erp_course_class_id=1252)
    OR EXISTS (SELECT 1 FROM writing_flow.web_substitute_attempt
               WHERE erp_course_class_id=1252 OR erp_student_contact_id=990056102)
  THEN RAISE EXCEPTION 'BROWSER_CLASS_CANARY_APPLY_SCOPE_MISMATCH'; END IF;
END $guard$;
INSERT INTO assessment_k56.term_test_roster
  (test_slug,erp_course_class_id,erp_student_contact_id,
   student_ref,student_name_snapshot,is_eligible)
VALUES ('term-test-1-k56',1252,990056102,
        '56000000-0000-4000-8000-000000000002',
        'Học viên giả web khóa 56',true);
INSERT INTO writing_flow.web_substitute_access
  (test_slug,cohort,erp_course_class_id,rubric_version,enabled,source)
VALUES ('substitute-test-2-k56',56,1252,
        'substitute-test2-k56-isolated-20260917-v1',true,'staging_fixture');
COMMIT;
"""

ROLLBACK_SQL = """-- Dữ liệu vào: đúng một lớp/học viên giả đã hoàn tất hoặc chưa nhận bài.
-- Việc chính: gỡ phiếu, lượt, quyền và roster chỉ theo ID giả đã khóa.
-- Kết quả: kho thử trở lại mốc bốn bài; bài thật và Portal không bị động tới.
-- Khi lỗi: rollback transaction; giữ nguyên dữ liệu để điều tra.
BEGIN;
SET LOCAL lock_timeout='5s';
SELECT pg_advisory_xact_lock(hashtext('substitute_browser_class_canary_20260925'));
DO $guard$ BEGIN
  IF current_database()<>'writing_practice_staging'
    OR (SELECT count(*) FROM assessment_k56.term_test_roster)<>2
    OR (SELECT count(*) FROM writing_flow.web_substitute_access)<>5
    OR (SELECT count(*) FROM assessment_k56.term_test_roster
        WHERE test_slug='term-test-1-k56' AND erp_course_class_id=1252
          AND erp_student_contact_id=990056102
          AND student_ref='56000000-0000-4000-8000-000000000002'::uuid
          AND student_name_snapshot='Học viên giả web khóa 56' AND is_eligible)<>1
    OR (SELECT count(*) FROM writing_flow.web_substitute_access
        WHERE test_slug='substitute-test-2-k56' AND erp_course_class_id=1252
          AND source='staging_fixture' AND enabled)<>1
    OR (SELECT count(*) FROM writing_flow.web_substitute_attempt) NOT IN (4,5)
    OR (SELECT count(*) FROM writing_flow.web_substitute_submission) NOT IN (4,5)
    OR EXISTS (SELECT 1 FROM writing_flow.web_substitute_submission
               WHERE status IN ('pending','running','needs_review'))
    OR (SELECT count(*) FROM writing_flow.web_substitute_portal_outbox)>1
    OR EXISTS (SELECT 1 FROM writing_flow.web_substitute_portal_outbox AS o
               JOIN writing_flow.web_substitute_submission AS s USING (submission_id)
               JOIN writing_flow.web_substitute_attempt AS a USING (attempt_id)
               WHERE a.erp_course_class_id<>1252
                  OR a.erp_student_contact_id<>990056102
                  OR o.status<>'pending' OR o.attempt_count<>0
                  OR o.portal_receipt_sha256 IS NOT NULL
                  OR o.portal_fields IS NOT NULL)
    OR EXISTS (SELECT 1 FROM writing_flow.web_substitute_submission AS s
               JOIN writing_flow.web_substitute_attempt AS a USING (attempt_id)
               WHERE a.erp_course_class_id=1252 AND a.erp_student_contact_id=990056102
                 AND s.status<>'completed')
  THEN RAISE EXCEPTION 'BROWSER_CLASS_CANARY_ROLLBACK_SCOPE_MISMATCH'; END IF;
END $guard$;
DELETE FROM writing_flow.web_substitute_portal_outbox AS o
USING writing_flow.web_substitute_submission AS s,
      writing_flow.web_substitute_attempt AS a
WHERE o.submission_id=s.submission_id AND s.attempt_id=a.attempt_id
  AND a.test_slug='substitute-test-2-k56'
  AND a.erp_course_class_id=1252 AND a.erp_student_contact_id=990056102
  AND o.status='pending' AND o.attempt_count=0;
DELETE FROM writing_flow.web_substitute_submission AS s
USING writing_flow.web_substitute_attempt AS a
WHERE s.attempt_id=a.attempt_id AND a.test_slug='substitute-test-2-k56'
  AND a.erp_course_class_id=1252 AND a.erp_student_contact_id=990056102;
DELETE FROM writing_flow.web_substitute_attempt
WHERE test_slug='substitute-test-2-k56' AND erp_course_class_id=1252
  AND erp_student_contact_id=990056102;
DELETE FROM writing_flow.web_substitute_access
WHERE test_slug='substitute-test-2-k56' AND erp_course_class_id=1252
  AND source='staging_fixture';
DELETE FROM assessment_k56.term_test_roster
WHERE test_slug='term-test-1-k56' AND erp_course_class_id=1252
  AND erp_student_contact_id=990056102
  AND student_ref='56000000-0000-4000-8000-000000000002'::uuid;
COMMIT;
"""


def remote(client, command, stdin_text=None):
    # Nhận lệnh đã khóa đích staging, giữ exit code và không in stderr/bí mật.
    stdin, stdout, stderr = client.exec_command(command, timeout=45)
    if stdin_text is not None:
        stdin.write(stdin_text)
        stdin.channel.shutdown_write()
    output = stdout.read().decode("utf-8", errors="replace").strip()
    stderr.read()
    if stdout.channel.recv_exit_status():
        raise RuntimeError("BROWSER_CLASS_CANARY_REMOTE_FAILED")
    return output


def psql(client, sql):
    command = ("docker exec -i mapping-postgres sh -lc 'psql -X -q "
               "-v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" "
               "-d writing_practice_staging -At -F \"|\"'")
    return remote(client, command, sql)


def counts(client):
    lines = psql(client, COUNTS_SQL).splitlines()
    if len(lines) != 1:
        raise RuntimeError("BROWSER_CLASS_CANARY_COUNTS_INVALID")
    fields = lines[0].split("|")
    if len(fields) != 11 or fields[0] != "writing_practice_staging":
        raise RuntimeError("BROWSER_CLASS_CANARY_DATABASE_MISMATCH")
    return list(map(int, fields[1:]))


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
        raise RuntimeError("BROWSER_CLASS_CANARY_BACKUP_INVALID")
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
            data = counts(client)
            print(json.dumps({"toolOutcome": "success", "businessOutcome": "inventory",
                              "database": "writing_practice_staging", "counts": data,
                              "productionWrites": 0}, ensure_ascii=False))
            return 0
        step = "verify_backup"
        digest = remote(client, "sha256sum -- " + shlex.quote(args.backup)).split(" ", 1)[0]
        if digest != args.sha256:
            raise RuntimeError("BROWSER_CLASS_CANARY_BACKUP_HASH_MISMATCH")
        remote(client, "docker exec -i mapping-postgres pg_restore -l < "
               + shlex.quote(args.backup) + " > /dev/null")
        step = "apply" if args.apply else "rollback"
        psql(client, APPLY_SQL if args.apply else ROLLBACK_SQL)
        data = counts(client)
        expected = ([2, 5, 4, 4, 0, 1, 1, 0, 0, 0] if args.apply
                    else [1, 4, 4, 4, 0, 0, 0, 0, 0, 0])
        if data != expected:
            raise RuntimeError("BROWSER_CLASS_CANARY_READBACK_MISMATCH")
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "verified",
                          "operation": step, "database": "writing_practice_staging",
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
