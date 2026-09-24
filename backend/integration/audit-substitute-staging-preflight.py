"""Chỉ đọc điều kiện mở phép thử Substitute trên VPS staging."""

import json
import sys
from urllib.parse import urlparse

import paramiko
import win32cred


def remote(client, command, stdin_text=None):
    # Dữ liệu vào: lệnh kiểm metadata cố định; SQL được chuyển qua stdin.
    # Việc chính: chạy chỉ đọc và lọc output ngay trong tiến trình.
    # Kết quả: stdout để đếm/kiểm cờ; khi lỗi không in stderr chứa cấu hình.
    input_stream, stdout, stderr = client.exec_command(command, timeout=30)
    if stdin_text is not None:
        input_stream.write(stdin_text)
        input_stream.channel.shutdown_write()
    value = stdout.read().decode("utf-8", errors="replace")
    stderr.read()
    status = stdout.channel.recv_exit_status()
    if status:
        raise RuntimeError(f"STAGING_READ_FAILED_{status}")
    return value.strip()


def main():
    expect_migrated = sys.argv[1:] == ["--expect-migrated"]
    if sys.argv[1:] not in ([], ["--expect-migrated"]):
        raise RuntimeError("STAGING_PREFLIGHT_ARGUMENT_INVALID")
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = (credential.get("UserName") or "root").strip().split("@", 1)[0]
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect("ducizone.ddns.net", port=22, username=username,
                       password=password, timeout=15)
        stage = "writing-task1-practice-api-staging"
        state = remote(client, "docker inspect --format "
                       "'{{.State.Health.Status}}|{{.RestartCount}}|{{.Image}}' " + stage)
        health, restart, image = state.split("|", 2)
        env_raw = remote(client, "docker inspect --format '{{json .Config.Env}}' " + stage)
        env = dict(value.split("=", 1) for value in json.loads(env_raw))
        env_names = set(env)
        stage_url_db = urlparse(env.get("DATABASE_URL", "")).path.lstrip("/")
        stage_database_url_matched = stage_url_db == "writing_practice_staging"
        stage_encryption_key_ready = len(env.get("WRITING_FLOW_ENCRYPTION_KEY", "")) == 64
        sql = """BEGIN READ ONLY;
SELECT current_database(),
  to_regnamespace('writing_flow') IS NOT NULL,
  to_regclass('writing_flow.source_record') IS NOT NULL,
  to_regnamespace('assessment') IS NULL,
  to_regnamespace('assessment_k56') IS NULL,
  to_regclass('writing_flow.web_substitute_access') IS NULL,
  to_regclass('writing_flow.web_substitute_attempt') IS NULL,
  EXISTS (SELECT 1 FROM pg_roles WHERE rolname='writing_practice_api');
COMMIT;
"""
        command = ("docker exec -i mapping-postgres sh -lc 'psql -X -q "
                   "-v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" "
                   "-d writing_practice_staging -At -F \"|\"'")
        row = remote(client, command, sql).splitlines()
        if len(row) != 1:
            raise RuntimeError("STAGING_METADATA_ROW_COUNT_INVALID")
        parts = row[0].split("|")
        if len(parts) != 8:
            raise RuntimeError("STAGING_METADATA_FORMAT_INVALID")
        target_db = parts[0] == "writing_practice_staging"
        expected_flags = ["t", "t", "f", "f", "f", "f", "t"] \
            if expect_migrated else ["t"] * 7
        expected = parts[1:] == expected_flags
        if expect_migrated and expected:
            migrated = remote(client, command, """BEGIN READ ONLY;
SELECT (SELECT count(*)::int FROM assessment.term_test_roster),
  (SELECT count(*)::int FROM assessment_k56.term_test_roster),
  (SELECT count(*)::int FROM writing_flow.web_substitute_access),
  (SELECT count(*)::int FROM writing_flow.web_substitute_attempt),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission);
COMMIT;
""").splitlines()
            expected = migrated == ["1|1|4|0|0"]
        image_has_web = remote(client,
                               "docker exec " + stage + " sh -lc "
                               "'test -f /app/src/writing-flow-web-queue.js "
                               "&& echo yes || echo no'") == "yes"
        outcome = ("ready_for_canary" if expect_migrated else "ready_for_backup") if (
            target_db and expected and stage_database_url_matched
            and stage_encryption_key_ready and health == "healthy"
            and not image_has_web and "DATABASE_URL" in env_names
            and "WRITING_FLOW_ENCRYPTION_KEY" in env_names
        ) else "prerequisite_changed"
        print(json.dumps({
            "toolOutcome": "success", "businessOutcome": outcome,
            "databaseMatched": target_db, "schemaPreconditionsMatched": expected,
            "stageDatabaseUrlMatched": stage_database_url_matched,
            "stageEncryptionKeyReady": stage_encryption_key_ready,
            "stageHealth": health, "stageRestartCount": int(restart),
            "stageImage": image, "webModuleInImage": image_has_web,
            "envKeysPresent": {
                key: key in env_names for key in (
                    "DATABASE_URL", "WRITING_FLOW_ENCRYPTION_KEY",
                    "WEB_SUBSTITUTE_ENABLED", "WEB_SUBSTITUTE_API_TOKEN",
                    "WEB_SUBSTITUTE_GRADER_TOKEN", "WEB_SUBSTITUTE_PORTAL_ENABLED",
                )
            }, "productionWrites": 0,
        }, ensure_ascii=False))
        return 0 if outcome in ("ready_for_backup", "ready_for_canary") else 2
    except (paramiko.SSHException, OSError, ValueError, RuntimeError,
            json.JSONDecodeError) as error:
        print(json.dumps({"toolOutcome": "failure", "businessOutcome": "unknown",
                          "errorType": type(error).__name__}, ensure_ascii=False),
              file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
