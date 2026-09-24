"""Chỉ đếm phiếu giả và kết quả trong database Writing staging."""

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
        # Dữ liệu vào: phiếu giả trên staging, không lấy bài/tên/điểm từng người.
        # Việc chính: đếm theo trạng thái và kiểm bài/feedback vẫn mã hóa.
        # Kết quả: snapshot để đối chiếu trước/sau n8n; khi lỗi không tự retry AI.
        sql = """BEGIN READ ONLY;
SELECT current_database(),
  (SELECT count(*)::int FROM writing_flow.web_substitute_attempt),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission
   WHERE status='pending'),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission
   WHERE status='running'),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission
   WHERE status IN ('completed','delivered')),
  (SELECT count(*)::int FROM writing_flow.web_substitute_submission
   WHERE status='needs_review'),
  (SELECT count(*)::int FROM writing_flow.web_substitute_portal_outbox),
  (SELECT bool_and(length(content_ciphertext)>32)
   FROM writing_flow.web_substitute_submission);
COMMIT;
"""
        command = ("docker exec -i mapping-postgres sh -lc 'psql -X -q "
                   "-v ON_ERROR_STOP=1 -U \"$POSTGRES_USER\" "
                   "-d writing_practice_staging -At -F \"|\"'")
        stdin, stdout, stderr = client.exec_command(command, timeout=30)
        stdin.write(sql)
        stdin.channel.shutdown_write()
        output = stdout.read().decode("utf-8", errors="replace").strip()
        stderr.read()
        if stdout.channel.recv_exit_status():
            raise RuntimeError("CANARY_DB_READ_FAILED")
        parts = output.split("|")
        if len(parts) != 9 or parts[0] != "writing_practice_staging":
            raise RuntimeError("CANARY_DB_READBACK_FORMAT_INVALID")
        counts = list(map(int, parts[1:8]))
        labels = ("attempts", "submissions", "pending", "running",
                  "completed", "needsReview", "portalOutbox")
        print(json.dumps({"toolOutcome": "success", "businessOutcome": "readback",
                          "database": "writing_practice_staging",
                          **dict(zip(labels, counts)),
                          "contentEncrypted": parts[8] == "t",
                          "productionWrites": 0}, ensure_ascii=False))
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
