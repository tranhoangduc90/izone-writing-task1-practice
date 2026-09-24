"""Cấp hoặc gỡ ba khóa Redis tạm cho HTTP canary Substitute, không in secret."""

import argparse
import json
import re
import shlex
import sys

import paramiko
import win32cred


PREFIX = "substitute:staging:web_20260925:"
SYNC_KEY = PREFIX + "sync_secret"
API_KEY = PREFIX + "api_token"
URL_KEY = PREFIX + "base_url"
URL = "http://writing-substitute-api-canary:8790/api/v1/internal/writing-flow/web-substitute"
TTL_SECONDS = 7200


def remote(client, command, script=None):
    # Dữ liệu vào: lệnh chỉ nhắm ba khóa thử; bí mật nằm trong container VPS.
    # Việc chính: chạy lệnh, tiêu thụ output trước khi xem exit code.
    # Kết quả: chỉ mã trạng thái/độ dài/TTL, không trả secret ra máy local.
    # Khi lỗi: dừng và báo mã bước để người vận hành kiểm tra ba key.
    stdin, stdout, stderr = client.exec_command(command, timeout=30)
    if script is not None:
        stdin.write(script)
        stdin.channel.shutdown_write()
    value = stdout.read().decode("utf-8", errors="replace").strip()
    stderr.read()
    if stdout.channel.recv_exit_status():
        raise RuntimeError("CANARY_WEB_KEY_COMMAND_FAILED")
    return value


def main():
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--inspect", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--rollback", action="store_true")
    parser.add_argument("--backup-dir", required=True)
    args = parser.parse_args()
    directory = args.backup_dir.replace("\\", "/")
    if not re.fullmatch(
        r"/opt/backups/writing-practice/substitute-canary-\d{8}T\d{6}Z",
        directory,
    ):
        raise RuntimeError("CANARY_WEB_BACKUP_DIRECTORY_INVALID")

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
        keys = (SYNC_KEY, API_KEY, URL_KEY)
        step = "readback_before"
        existing = int(remote(client, "docker exec redis redis-cli EXISTS " + " ".join(keys)))
        if args.inspect:
            ttl = {key.removeprefix(PREFIX): int(remote(
                client, "docker exec redis redis-cli TTL " + key)) for key in keys}
            print(json.dumps({"toolOutcome": "success", "businessOutcome": "inventory",
                              "existingCount": existing, "ttl": ttl,
                              "productionWrites": 0}))
            return 0
        if args.rollback:
            step = "rollback"
            deleted = int(remote(client, "docker exec redis redis-cli DEL " + " ".join(keys)))
            after = int(remote(client, "docker exec redis redis-cli EXISTS " + " ".join(keys)))
            if after:
                raise RuntimeError("CANARY_WEB_KEY_ROLLBACK_UNCONFIRMED")
            print(json.dumps({"toolOutcome": "success", "businessOutcome": "rolled_back",
                              "deletedCount": deleted, "remainingCount": 0,
                              "productionKeyUntouched": True}))
            return 0
        if existing:
            raise RuntimeError("CANARY_WEB_KEYS_ALREADY_EXIST")
        health = remote(client, "docker inspect --format '{{.State.Health.Status}}' "
                        "writing-substitute-api-canary")
        if health != "healthy":
            raise RuntimeError("CANARY_WEB_BACKEND_NOT_HEALTHY")

        # Dữ liệu vào: token API trong canary.env và secret ngẫu nhiên tạo trên VPS.
        # Việc chính: ghi NX + TTL, không sửa khóa workflow cũ.
        # Kết quả: ba khóa tạm độc lập cho intake/status/public canary.
        # Khi lỗi: chỉ cần --inspect rồi --rollback ba khóa có tiền tố đã khóa.
        lua = ("if redis.call('EXISTS',KEYS[1])==0 then "
               "return redis.call('SET',KEYS[1],ARGV[1],'EX',7200,'NX') "
               "else return 'EXISTS' end")
        script = ("#!/bin/sh\nset -eu\n"
                  + "token=$(sed -n 's/^WEB_SUBSTITUTE_API_TOKEN=//p' "
                  + shlex.quote(directory + "/canary.env") + ")\n"
                  + "live_token=$(docker exec writing-substitute-api-canary "
                  + "printenv WEB_SUBSTITUTE_API_TOKEN)\n"
                  + "test ${#token} -eq 64\n"
                  + "test \"$token\" = \"$live_token\"\n"
                  + "sync=$(openssl rand -hex 32)\n"
                  + "test ${#sync} -eq 64\n"
                  + "printf %s \"$sync\" | docker exec -i redis redis-cli -x EVAL "
                  + shlex.quote(lua) + " 1 " + SYNC_KEY + "\n"
                  + "printf %s \"$token\" | docker exec -i redis redis-cli -x EVAL "
                  + shlex.quote(lua) + " 1 " + API_KEY + "\n"
                  + "printf %s " + shlex.quote(URL)
                  + " | docker exec -i redis redis-cli -x EVAL "
                  + shlex.quote(lua) + " 1 " + URL_KEY + "\n")
        step = "apply"
        if remote(client, "sh -s", script).splitlines() != ["OK", "OK", "OK"]:
            raise RuntimeError("CANARY_WEB_KEY_SET_UNCONFIRMED")
        step = "readback_after"
        lengths = {key.removeprefix(PREFIX): int(remote(
            client, "docker exec redis redis-cli STRLEN " + key)) for key in keys}
        ttls = {key.removeprefix(PREFIX): int(remote(
            client, "docker exec redis redis-cli TTL " + key)) for key in keys}
        url = remote(client, "docker exec redis redis-cli GET " + URL_KEY)
        if lengths != {"sync_secret": 64, "api_token": 64, "base_url": len(URL)} \
                or min(ttls.values()) < TTL_SECONDS - 120 or url != URL:
            raise RuntimeError("CANARY_WEB_KEY_READBACK_MISMATCH")
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "verified",
                          "keyLengths": lengths, "ttlMinimum": min(ttls.values()),
                          "canaryUrlMatched": True, "productionKeyUntouched": True}))
        return 0
    except (paramiko.SSHException, OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"toolOutcome": "failure", "businessOutcome": "partial"
                          if step in ("apply", "readback_after", "rollback") else "unknown",
                          "step": step, "errorType": type(error).__name__}),
              file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
