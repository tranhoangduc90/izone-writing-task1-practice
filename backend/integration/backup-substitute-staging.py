"""Tạo và xác minh bản sao kho Writing staging trước thử Substitute."""

import datetime
import json
import re
import shlex
import sys

import paramiko
import win32cred


def remote(client, command, timeout=120):
    # Dữ liệu vào: lệnh backup chỉ hướng đến database staging và thư mục mới.
    # Việc chính: chạy rồi trả stdout đã lọc; không in stderr/biến môi trường.
    # Kết quả: thông tin kích thước/hash/đường backup không chứa bài học viên.
    # Khi lỗi: dừng, không tạo bước triển khai kế tiếp.
    _stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
    output = stdout.read().decode("utf-8", errors="replace").strip()
    stderr.read()
    status = stdout.channel.recv_exit_status()
    if status:
        raise RuntimeError(f"STAGING_BACKUP_COMMAND_FAILED_{status}")
    return output


def main():
    if sys.argv[1:] != ["--apply"]:
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "dry_run",
                          "targetDatabase": "writing_practice_staging",
                          "remoteRoot": "/opt/backups/writing-practice"}))
        return 0
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = (credential.get("UserName") or "root").strip().split("@", 1)[0]
    password = credential["CredentialBlob"].decode("utf-16-le")
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    directory = f"/opt/backups/writing-practice/substitute-canary-{stamp}"
    dump = directory + "/writing-practice-staging-before-substitute.dump"
    if not re.fullmatch(r"/opt/backups/writing-practice/substitute-canary-\d{8}T\d{6}Z",
                        directory):
        raise RuntimeError("STAGING_BACKUP_PATH_INVALID")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect("ducizone.ddns.net", port=22, username=username,
                       password=password, timeout=15)
        resolved = remote(client, "readlink -f /opt/backups/writing-practice")
        if resolved != "/opt/backups/writing-practice":
            raise RuntimeError("STAGING_BACKUP_ROOT_MISMATCH")
        remote(client, "mkdir -m 700 -- " + shlex.quote(directory))
        remote(client, "umask 077; docker exec mapping-postgres sh -lc "
               "'exec pg_dump -Fc -U \"$POSTGRES_USER\" "
               "-d writing_practice_staging' > " + shlex.quote(dump), timeout=180)
        remote(client, "docker exec -i mapping-postgres pg_restore -l < "
               + shlex.quote(dump) + " > /dev/null", timeout=60)
        details = remote(client, "stat -c '%s|%a' -- " + shlex.quote(dump)
                         + " && sha256sum -- " + shlex.quote(dump))
        lines = details.splitlines()
        if len(lines) != 2:
            raise RuntimeError("STAGING_BACKUP_READBACK_INVALID")
        size_text, mode = lines[0].split("|", 1)
        digest = lines[1].split(" ", 1)[0]
        size = int(size_text)
        if size < 1000 or mode != "600" or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise RuntimeError("STAGING_BACKUP_VERIFICATION_FAILED")
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "verified",
                          "targetDatabase": "writing_practice_staging",
                          "remoteBackup": dump, "sizeBytes": size,
                          "sha256": digest, "fileMode": mode,
                          "productionWrites": 0}, ensure_ascii=False))
        return 0
    except (paramiko.SSHException, OSError, ValueError, RuntimeError) as error:
        print(json.dumps({"toolOutcome": "failure", "businessOutcome": "unknown",
                          "errorType": type(error).__name__,
                          "remoteBackupDirectory": directory}, ensure_ascii=False),
              file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
