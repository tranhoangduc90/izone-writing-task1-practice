"""Gửi một test HTTP giả vào canary qua stdin, không đưa token ra máy local."""

import argparse
import json
import sys
from pathlib import Path

import paramiko
import win32cred


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("step", choices=("intake", "remaining-intake", "result",
                                         "all-results"))
    args = parser.parse_args()
    source = Path(__file__).with_name(f"canary-substitute-{args.step}.mjs").read_text(
        encoding="utf-8")
    credential = win32cred.CredRead("Codex/SSH/vps_1", win32cred.CRED_TYPE_GENERIC, 0)
    username = (credential.get("UserName") or "root").strip().split("@", 1)[0]
    password = credential["CredentialBlob"].decode("utf-16-le")
    client = paramiko.SSHClient()
    client.load_system_host_keys()
    client.set_missing_host_key_policy(paramiko.RejectPolicy())
    try:
        client.connect("ducizone.ddns.net", port=22, username=username,
                       password=password, timeout=15)
        # Dữ liệu vào: mã test chỉ chứa bài/tên giả; token nằm sẵn trong canary.
        # Việc chính: cho Node trong canary gọi HTTP localhost, rồi lọc JSON tổng hợp.
        # Kết quả: bằng chứng phiếu bền/mở lại; khi lỗi không in bài hoặc secret.
        stdin, stdout, stderr = client.exec_command(
            "docker exec -i writing-substitute-api-canary node --input-type=module",
            timeout=90)
        stdin.write(source)
        stdin.channel.shutdown_write()
        output = stdout.read().decode("utf-8", errors="replace").strip()
        error = stderr.read().decode("utf-8", errors="replace").strip()
        status = stdout.channel.recv_exit_status()
        if status:
            code = "CANARY_HTTP_TEST_FAILED"
            try:
                parsed = json.loads(error.splitlines()[-1])
                code = parsed.get("errorCode", code)
            except (ValueError, IndexError):
                pass
            print(json.dumps({"toolOutcome": "failure", "businessOutcome": "unknown",
                              "step": args.step, "errorCode": code,
                              "exitCode": status}), file=sys.stderr)
            return 1
        data = json.loads(output)
        if data.get("toolOutcome") != "success" or data.get("businessOutcome") != "verified":
            raise RuntimeError("CANARY_TEST_RESULT_INVALID")
        print(json.dumps(data, ensure_ascii=False))
        return 0
    except (paramiko.SSHException, OSError, RuntimeError, ValueError) as error:
        print(json.dumps({"toolOutcome": "failure", "businessOutcome": "unknown",
                          "errorType": type(error).__name__}), file=sys.stderr)
        return 1
    finally:
        client.close()


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
