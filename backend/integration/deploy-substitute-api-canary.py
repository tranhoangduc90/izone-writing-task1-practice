"""Dựng API Substitute tạm trên VPS; không thay container staging/production."""

import argparse
import hashlib
import io
import json
import re
import shlex
import sys
import tarfile
from pathlib import Path

import paramiko
import win32cred


ROOT = Path(__file__).resolve().parents[1]
CANARY = "writing-substitute-api-canary"


def bundle():
    # Dữ liệu vào: Dockerfile, package manifest và src của backend đã test.
    # Việc chính: gói allowlist; không mang .env, bài học viên hoặc node_modules.
    # Kết quả: tar.gz nhỏ có hash để đối chiếu image; lỗi file lạ thì dừng.
    files = [ROOT / "Dockerfile", ROOT / "package.json", ROOT / "package-lock.json"]
    files += sorted((ROOT / "src").rglob("*"))
    output = io.BytesIO()
    with tarfile.open(fileobj=output, mode="w:gz") as archive:
        for path in files:
            if path.is_dir():
                continue
            if not path.is_file() or path.is_symlink():
                raise RuntimeError("CANARY_SOURCE_NOT_REGULAR")
            archive.add(path, arcname=path.relative_to(ROOT).as_posix(), recursive=False)
    value = output.getvalue()
    if not 1000 < len(value) < 5_000_000:
        raise RuntimeError("CANARY_BUNDLE_SIZE_INVALID")
    return value, hashlib.sha256(value).hexdigest(), len(files)


def remote(client, command, timeout=60, stdin_text=None):
    # Dữ liệu vào: lệnh Docker chỉ cho API canary và thư mục backup đã ghim.
    # Việc chính: chạy một bước và chỉ giữ stdout an toàn, không in log build/env.
    # Kết quả: chuỗi readback; lỗi giữ nguyên trạng thái để điều tra/hoàn tác.
    input_stream, stdout, stderr = client.exec_command(command, timeout=timeout)
    if stdin_text is not None:
        input_stream.write(stdin_text)
        input_stream.channel.shutdown_write()
    data = stdout.read().decode("utf-8", errors="replace").strip()
    stderr.read()
    status = stdout.channel.recv_exit_status()
    if status:
        raise RuntimeError(f"CANARY_COMMAND_FAILED_{status}")
    return data


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
        raise RuntimeError("CANARY_BACKUP_IDENTITY_INVALID")
    archive, archive_sha, source_count = bundle()
    tag = "writing-substitute-api-canary:" + archive_sha[:12]
    if not args.apply:
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "dry_run",
                          "container": CANARY, "imageTag": tag,
                          "sourceFiles": source_count, "archiveBytes": len(archive),
                          "targetDatabase": "writing_practice_staging"}))
        return 0
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = (credential.get("UserName") or "root").strip().split("@", 1)[0]
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    step = "connect"
    directory = backup.rsplit("/", 1)[0]
    try:
        client.connect("ducizone.ddns.net", port=22, username=username,
                       password=password, timeout=15)
        step = "verify_backup"
        digest = remote(client, "sha256sum -- " + shlex.quote(backup)).split(" ", 1)[0]
        if digest != args.sha256:
            raise RuntimeError("CANARY_BACKUP_HASH_MISMATCH")
        step = "verify_container_absent"
        existing = remote(client, "docker ps -a --filter "
                          + shlex.quote("name=^/" + CANARY + "$")
                          + " --format '{{.Names}}'")
        if existing:
            raise RuntimeError("CANARY_CONTAINER_ALREADY_EXISTS")
        step = "verify_staging_scope"
        scope = remote(client, "docker exec -i mapping-postgres sh -lc 'psql -X -q "
                       "-v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" "
                       "-d writing_practice_staging -At'",
                       stdin_text="""BEGIN READ ONLY;
SELECT count(*) FROM writing_flow.web_substitute_access
WHERE source = 'staging_fixture';
COMMIT;
""")
        if scope != "4":
            raise RuntimeError("CANARY_STAGING_ACCESS_SCOPE_CHANGED")
        step = "upload_source"
        build_dir = directory + "/backend-canary-build"
        remote(client, "mkdir -m 700 -- " + shlex.quote(build_dir))
        tar_path = directory + "/backend-canary-source.tar.gz"
        sftp = client.open_sftp()
        try:
            sftp.putfo(io.BytesIO(archive), tar_path, file_size=len(archive), confirm=True)
            sftp.chmod(tar_path, 0o600)
            script_path = directory + "/create-canary-env.sh"
            env_path = directory + "/canary.env"
            script = """#!/bin/sh
set -eu
umask 077
cp -- /opt/writing-task1-practice-api-staging/.env """ + shlex.quote(env_path) + """
api=$(openssl rand -hex 32)
grader=$(openssl rand -hex 32)
test "$api" != "$grader"
printf '\\nWEB_SUBSTITUTE_ENABLED=true\\nWEB_SUBSTITUTE_PORTAL_ENABLED=false\\nWEB_SUBSTITUTE_API_TOKEN=%s\\nWEB_SUBSTITUTE_GRADER_TOKEN=%s\\n' "$api" "$grader" >> """ + shlex.quote(env_path) + "\n"
            with sftp.open(script_path, "wb") as stream:
                stream.write(script.encode("utf-8"))
            sftp.chmod(script_path, 0o700)
        finally:
            sftp.close()
        readback_sha = remote(client, "sha256sum -- " + shlex.quote(tar_path)).split(" ", 1)[0]
        if readback_sha != archive_sha:
            raise RuntimeError("CANARY_SOURCE_UPLOAD_MISMATCH")
        step = "build_image"
        log_path = directory + "/canary-build.log"
        remote(client, "tar -xzf " + shlex.quote(tar_path) + " -C "
               + shlex.quote(build_dir))
        remote(client, "docker build --pull=false -t " + shlex.quote(tag) + " "
               + shlex.quote(build_dir) + " > " + shlex.quote(log_path) + " 2>&1",
               timeout=600)
        image = remote(client, "docker image inspect --format '{{.Id}}' " + shlex.quote(tag))
        remote(client, "docker run --rm --entrypoint sh " + shlex.quote(tag)
               + " -lc 'test -f /app/src/writing-flow-web-queue.js'")
        step = "prepare_private_env"
        remote(client, "sh " + shlex.quote(script_path))
        mode = remote(client, "stat -c '%a' -- " + shlex.quote(env_path))
        if mode != "600":
            raise RuntimeError("CANARY_ENV_PERMISSION_INVALID")
        step = "start_canary"
        remote(client, "docker run -d --name " + CANARY
               + " --restart=no --env-file " + shlex.quote(env_path)
               + " --network mapping-api-net --read-only"
               + " --tmpfs /tmp:size=16m,noexec,nosuid,nodev"
               + " --cap-drop ALL --security-opt no-new-privileges"
               + " --pids-limit 100 --memory 256m --cpus 0.50"
               + " --log-opt max-size=10m --log-opt max-file=3 " + shlex.quote(tag))
        step = "connect_n8n_network"
        remote(client, "docker network connect n8n-net " + CANARY)
        state = remote(client, "docker inspect --format "
                       "'{{.State.Status}}|{{.RestartCount}}|{{.Image}}' " + CANARY)
        status, restarts, running_image = state.split("|", 2)
        if status != "running" or restarts != "0" or running_image != image:
            raise RuntimeError("CANARY_START_READBACK_MISMATCH")
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "deployed_awaiting_health",
                          "container": CANARY, "imageTag": tag, "imageId": image,
                          "archiveSha256": archive_sha, "sourceFiles": source_count,
                          "sourceBytes": len(archive), "network": ["mapping-api-net", "n8n-net"],
                          "targetDatabase": "writing_practice_staging",
                          "envFileMode": mode, "productionWrites": 0}, ensure_ascii=False))
        return 0
    except (paramiko.SSHException, OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"toolOutcome": "failure", "businessOutcome": "partial",
                          "step": step, "errorType": type(error).__name__,
                          "backupDirectory": directory}, ensure_ascii=False), file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
