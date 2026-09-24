"""Áp roster giả và v16–v18 lên đúng Writing staging sau backup đã kiểm."""

import argparse
import json
import re
import shlex
import sys
from pathlib import Path

import paramiko
import win32cred


ROOT = Path(__file__).resolve().parents[2]
FILES = [
    ("roster", ROOT / "backend/integration/staging-substitute-roster.sql"),
    ("v16", ROOT / "docs/migrations/2026-09-24-writing-flow-web-substitute-roster-v16.sql"),
    ("v17", ROOT / "docs/migrations/2026-09-24-writing-flow-web-substitute-intake-v17.sql"),
    ("v18", ROOT / "docs/migrations/2026-09-24-writing-flow-web-substitute-portal-v18.sql"),
    ("access", ROOT / "backend/integration/staging-substitute-access.sql"),
]


def remote(client, command, stdin_text=None, timeout=45):
    # Dữ liệu vào: lệnh SQL cố định vào database staging; secret chỉ ở server.
    # Việc chính: chạy đúng một bước, không in SQL hoặc stderr khi có lỗi.
    # Kết quả: stdout để so aggregate; lỗi dừng, không tự chạy lại migration.
    input_stream, stdout, stderr = client.exec_command(command, timeout=timeout)
    if stdin_text is not None:
        input_stream.write(stdin_text)
        input_stream.channel.shutdown_write()
    result = stdout.read().decode("utf-8", errors="replace").strip()
    stderr.read()
    status = stdout.channel.recv_exit_status()
    if status:
        raise RuntimeError(f"STAGING_SCHEMA_COMMAND_FAILED_{status}")
    return result


def psql(client, text):
    command = ("docker exec -i mapping-postgres sh -lc 'psql -X -q "
               "-v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" "
               "-d writing_practice_staging -At -F \"|\"'")
    return remote(client, command, text)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup", required=True)
    parser.add_argument("--sha256", required=True)
    args = parser.parse_args()
    backup = args.backup.replace("\\", "/")
    if not re.fullmatch(
        r"/opt/backups/writing-practice/substitute-canary-\d{8}T\d{6}Z/"
        r"writing-practice-staging-before-substitute\.dump", backup
    ) or not re.fullmatch(r"[0-9a-f]{64}", args.sha256):
        raise RuntimeError("STAGING_BACKUP_IDENTITY_INVALID")
    if not args.apply:
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "dry_run",
                          "targetDatabase": "writing_practice_staging",
                          "steps": [name for name, _ in FILES]}, ensure_ascii=False))
        return 0
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = (credential.get("UserName") or "root").strip().split("@", 1)[0]
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    step = "connect"
    completed = []
    try:
        client.connect("ducizone.ddns.net", port=22, username=username,
                       password=password, timeout=15)
        step = "verify_backup"
        digest = remote(client, "sha256sum -- " + shlex.quote(backup)).split(" ", 1)[0]
        if digest != args.sha256:
            raise RuntimeError("STAGING_BACKUP_HASH_MISMATCH")
        remote(client, "docker exec -i mapping-postgres pg_restore -l < "
               + shlex.quote(backup) + " > /dev/null")
        step = "verify_empty_scope"
        preflight = psql(client, """BEGIN READ ONLY;
SELECT current_database(),
  to_regnamespace('assessment') IS NULL,
  to_regnamespace('assessment_k56') IS NULL,
  to_regclass('writing_flow.web_substitute_access') IS NULL,
  to_regclass('writing_flow.web_substitute_attempt') IS NULL;
COMMIT;
""").splitlines()
        if preflight != ["writing_practice_staging|t|t|t|t"]:
            raise RuntimeError("STAGING_SCHEMA_PREFLIGHT_CHANGED")
        directory = backup.rsplit("/", 1)[0]
        sftp = client.open_sftp()
        try:
            for name, source in FILES:
                step = "upload_" + name
                target = directory + "/apply-" + name + ".sql"
                sftp.put(str(source), target, confirm=True)
                sftp.chmod(target, 0o600)
                step = "apply_" + name
                command = ("docker exec -i mapping-postgres sh -lc 'psql -X -q "
                           "-v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" "
                           "-d writing_practice_staging' < " + shlex.quote(target))
                remote(client, command, timeout=60)
                completed.append(name)
        finally:
            sftp.close()
        step = "readback"
        readback = psql(client, """BEGIN READ ONLY;
SELECT current_database(),
  (SELECT count(*)::int FROM assessment.term_test_roster),
  (SELECT count(*)::int FROM assessment_k56.term_test_roster),
  (SELECT count(*)::int FROM writing_flow.web_substitute_access),
  (SELECT count(*)::int FROM writing_flow.web_substitute_attempt),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission),
  (SELECT count(*)::int FROM writing_flow.web_substitute_portal_outbox),
  (SELECT bool_and(enabled AND source='staging_fixture')
   FROM writing_flow.web_substitute_access);
COMMIT;
""").splitlines()
        if readback != ["writing_practice_staging|1|1|4|0|0|0|t"]:
            raise RuntimeError("STAGING_SCHEMA_READBACK_MISMATCH")
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "verified",
                          "database": "writing_practice_staging", "completed": completed,
                          "rosterRows": {"k56": 1, "k67": 1}, "accessPairs": 4,
                          "attempts": 0, "submissions": 0, "portalOutbox": 0,
                          "productionWrites": 0}, ensure_ascii=False))
        return 0
    except (paramiko.SSHException, OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"toolOutcome": "failure", "businessOutcome": "partial"
                          if completed else "unknown", "step": step,
                          "completed": completed, "errorType": type(error).__name__,
                          "backup": backup}, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
