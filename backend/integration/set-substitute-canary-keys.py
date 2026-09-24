"""Đặt hai khóa Redis TTL riêng cho workflow canary, không in token."""

import argparse
import json
import re
import shlex
import sys

import paramiko
import win32cred


TOKEN_KEY = "substitute:staging:grader_token"
URL_KEY = "substitute:staging:gateway_base_url"
URL = "http://writing-substitute-api-canary:8790/api/v1/internal/writing-flow/web-substitute"


def remote(client, command):
    # Dữ liệu vào: hai key staging cố định; token chỉ đọc trong shell VPS.
    # Việc chính: ghi NX + TTL qua Redis rồi chỉ đọc TTL/độ dài, không đọc secret.
    # Kết quả: hai key tạm đúng namespace; khi lỗi dừng trước khi chạy AI.
    _stdin, stdout, stderr = client.exec_command(command, timeout=20)
    result = stdout.read().decode("utf-8", errors="replace").strip()
    stderr.read()
    if stdout.channel.recv_exit_status():
        raise RuntimeError("CANARY_REDIS_COMMAND_FAILED")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--backup-dir", required=True)
    args = parser.parse_args()
    directory = args.backup_dir.replace("\\", "/")
    if not re.fullmatch(
        r"/opt/backups/writing-practice/substitute-canary-\d{8}T\d{6}Z",
        directory,
    ):
        raise RuntimeError("CANARY_REDIS_DIRECTORY_INVALID")
    if not args.apply:
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "dry_run",
                          "keys": [TOKEN_KEY, URL_KEY], "ttlSeconds": 7200}))
        return 0
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
        step = "readback_before"
        exists = remote(client, "docker exec redis redis-cli EXISTS "
                        + TOKEN_KEY + " " + URL_KEY)
        if exists != "0":
            raise RuntimeError("CANARY_REDIS_KEYS_ALREADY_EXIST")
        prior = remote(client,
                       "docker exec redis redis-cli --scan --pattern 'substitute:*' | wc -l")
        if int(prior) < 1:
            raise RuntimeError("CANARY_REDIS_DATABASE_UNCONFIRMED")
        lua = ("if redis.call('EXISTS',KEYS[1])==0 then "
               "return redis.call('SET',KEYS[1],ARGV[1],'EX',7200,'NX') "
               "else return 'EXISTS' end")
        step = "set_isolated_keys"
        script_path = directory + "/set-canary-redis.sh"
        script = ("#!/bin/sh\nset -eu\n"
                  + "token=$(sed -n 's/^WEB_SUBSTITUTE_GRADER_TOKEN=//p' "
                  + shlex.quote(directory + "/canary.env") + ")\n"
                  + "test ${#token} -eq 64\n"
                  + "printf %s \"$token\" | docker exec -i redis redis-cli -x EVAL "
                  + shlex.quote(lua) + " 1 " + TOKEN_KEY + "\n"
                  + "printf %s " + shlex.quote(URL)
                  + " | docker exec -i redis redis-cli -x EVAL "
                  + shlex.quote(lua) + " 1 " + URL_KEY + "\n")
        sftp = client.open_sftp()
        try:
            with sftp.open(script_path, "wb") as stream:
                stream.write(script.encode("utf-8"))
            sftp.chmod(script_path, 0o700)
        finally:
            sftp.close()
        if remote(client, "sh " + shlex.quote(script_path)).splitlines() != ["OK", "OK"]:
            raise RuntimeError("CANARY_REDIS_SET_UNCONFIRMED")
        step = "readback_after"
        lengths = remote(client, "docker exec redis redis-cli STRLEN " + TOKEN_KEY)
        url = remote(client, "docker exec redis redis-cli GET " + URL_KEY)
        token_ttl = int(remote(client, "docker exec redis redis-cli TTL " + TOKEN_KEY))
        url_ttl = int(remote(client, "docker exec redis redis-cli TTL " + URL_KEY))
        if lengths != "64" or url != URL or min(token_ttl, url_ttl) < 6000:
            raise RuntimeError("CANARY_REDIS_READBACK_MISMATCH")
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "verified",
                          "tokenLength": int(lengths), "urlMatched": True,
                          "ttlSecondsMinimum": min(token_ttl, url_ttl),
                          "productionKeyUntouched": True}, ensure_ascii=False))
        return 0
    except (paramiko.SSHException, OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"toolOutcome": "failure", "businessOutcome": "partial",
                          "step": step, "errorType": type(error).__name__}),
              file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
