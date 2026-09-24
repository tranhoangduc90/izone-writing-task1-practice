"""Kiểm read-only Redis mà workflow canary dùng; không đọc key hay secret."""

import json
import sys

import paramiko
import win32cred


def main():
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = (credential.get("UserName") or "root").strip().split("@", 1)[0]
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect("ducizone.ddns.net", port=22, username=username,
                       password=password, timeout=15)
        _stdin, stdout, stderr = client.exec_command(
            "docker ps --format '{{.Names}}'", timeout=15)
        names = stdout.read().decode("utf-8", errors="replace").splitlines()
        stderr.read()
        if stdout.channel.recv_exit_status():
            raise RuntimeError("REDIS_DOCKER_LIST_FAILED")
        selected = [name for name in names if "redis" in name.lower()]
        _stdin, info, errors = client.exec_command(
            "docker inspect --format '{{json .NetworkSettings.Networks}}' redis",
            timeout=15)
        networks = sorted(json.loads(info.read().decode("utf-8")).keys())
        errors.read()
        if info.channel.recv_exit_status():
            raise RuntimeError("REDIS_NETWORK_READ_FAILED")
        _stdin, ping, errors = client.exec_command(
            "docker exec redis redis-cli ping", timeout=15)
        ping_answer = ping.read().decode("utf-8", errors="replace").strip()
        errors.read()
        ping_exit = ping.channel.recv_exit_status()
        _stdin, keys, errors = client.exec_command(
            "docker exec redis redis-cli EXISTS "
            "substitute:staging:grader_token substitute:staging:gateway_base_url "
            "substitute:web:gateway_base_url", timeout=15)
        key_count = keys.read().decode("utf-8", errors="replace").strip()
        errors.read()
        if keys.channel.recv_exit_status():
            raise RuntimeError("REDIS_KEY_SCOPE_READ_FAILED")
        _stdin, scan, errors = client.exec_command(
            "docker exec redis redis-cli --scan --pattern 'substitute:*' | wc -l",
            timeout=20)
        substitute_count = scan.read().decode("utf-8", errors="replace").strip()
        errors.read()
        if scan.channel.recv_exit_status():
            raise RuntimeError("REDIS_PREFIX_COUNT_FAILED")
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "inventory",
                          "redisContainerNames": selected, "redisNetworks": networks,
                          "redisPingNoAuth": ping_answer == "PONG" and ping_exit == 0,
                          "trackedKeyExistsCount": int(key_count),
                          "substitutePrefixKeyCount": int(substitute_count),
                          "productionWrites": 0}))
        return 0
    except (paramiko.SSHException, OSError, RuntimeError) as error:
        print(json.dumps({"toolOutcome": "failure", "businessOutcome": "unknown",
                          "errorType": type(error).__name__}), file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
