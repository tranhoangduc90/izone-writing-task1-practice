"""Đọc health, mạng, kho và cờ của API canary mà không in secret."""

import json
import sys
from urllib.parse import urlparse

import paramiko
import win32cred


def remote(client, command):
    _stdin, stdout, stderr = client.exec_command(command, timeout=20)
    value = stdout.read().decode("utf-8", errors="replace").strip()
    stderr.read()
    if stdout.channel.recv_exit_status():
        raise RuntimeError("CANARY_READBACK_COMMAND_FAILED")
    return value


def main():
    # Dữ liệu vào: container canary riêng và staging/production đang chạy.
    # Việc chính: đối chiếu health qua chính n8n, DB/khóa chỉ theo cờ và image.
    # Kết quả: trạng thái canary tách với hai dịch vụ cũ; không in token hoặc bài.
    # Khi lỗi: trả unknown, không tự khởi động lại hoặc thay service.
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = (credential.get("UserName") or "root").strip().split("@", 1)[0]
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect("ducizone.ddns.net", port=22, username=username,
                       password=password, timeout=15)
        names = ("writing-substitute-api-canary", "writing-task1-practice-api-staging",
                 "writing-task1-practice-api")
        states = {}
        for name in names:
            fields = remote(client, "docker inspect --format "
                            "'{{.State.Health.Status}}|{{.RestartCount}}|{{.Image}}' "
                            + name).split("|", 2)
            states[name] = {"health": fields[0], "restarts": int(fields[1]),
                            "image": fields[2]}
        environment = json.loads(remote(client,
            "docker inspect --format '{{json .Config.Env}}' writing-substitute-api-canary"))
        env = dict(value.split("=", 1) for value in environment)
        canary_db = urlparse(env.get("DATABASE_URL", "")).path.lstrip("/")
        token_ready = (len(env.get("WEB_SUBSTITUTE_API_TOKEN", "")) >= 32
                       and len(env.get("WEB_SUBSTITUTE_GRADER_TOKEN", "")) >= 32
                       and env.get("WEB_SUBSTITUTE_API_TOKEN")
                       != env.get("WEB_SUBSTITUTE_GRADER_TOKEN"))
        n8n_health = json.loads(remote(client,
            "docker exec n8n wget -qO- -T 5 "
            "http://writing-substitute-api-canary:8790/health"))
        n8n_ready = json.loads(remote(client,
            "docker exec n8n wget -qO- -T 5 "
            "http://writing-substitute-api-canary:8790/ready"))
        success = (all(row["health"] == "healthy" and row["restarts"] == 0
                       for row in states.values())
                   and canary_db == "writing_practice_staging" and token_ready
                   and env.get("WEB_SUBSTITUTE_ENABLED") == "true"
                   and env.get("WEB_SUBSTITUTE_PORTAL_ENABLED") == "false"
                   and (n8n_health.get("ok") is True or n8n_health.get("status") == "ok")
                   and (n8n_ready.get("ok") is True or n8n_ready.get("status") == "ok"))
        print(json.dumps({"toolOutcome": "success",
                          "businessOutcome": "ready_for_synthetic_intake" if success
                          else "not_ready", "containers": states,
                          "canaryDatabaseMatched": canary_db == "writing_practice_staging",
                          "separateTokensReady": token_ready,
                          "canaryEnabled": env.get("WEB_SUBSTITUTE_ENABLED") == "true",
                          "portalDisabled": env.get("WEB_SUBSTITUTE_PORTAL_ENABLED") == "false",
                          "healthFromN8n": n8n_health.get("status", n8n_health.get("ok")),
                          "readyFromN8n": n8n_ready.get("status", n8n_ready.get("ok")),
                          "productionWrites": 0}, ensure_ascii=False))
        return 0 if success else 2
    except (paramiko.SSHException, OSError, RuntimeError, ValueError,
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
