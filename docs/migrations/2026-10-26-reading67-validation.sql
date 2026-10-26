-- Lịch sử kiểm/bổ sung. Không cập nhật bản nộp, nháp hoặc kết quả cũ.
CREATE TABLE IF NOT EXISTS reading_listening67.web_validation (
 job_id uuid PRIMARY KEY REFERENCES reading_listening67.web_job(id),
 state jsonb NOT NULL DEFAULT '{}', next_attempt_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS reading_listening67.web_validation_round (
 call_id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES reading_listening67.web_job(id),
 phase text NOT NULL, round_no integer, status text NOT NULL,
 prompt_hash text, response jsonb, metadata jsonb NOT NULL DEFAULT '{}',
 created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS web_validation_round_job ON reading_listening67.web_validation_round(job_id,created_at);
CREATE TABLE IF NOT EXISTS reading_listening67.web_validation_event (
 id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES reading_listening67.web_job(id),
 kind text NOT NULL, data jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
