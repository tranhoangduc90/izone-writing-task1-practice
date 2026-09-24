// Dữ liệu vào: ba lượt giả đã mở trước đó trong database Writing staging.
// Việc chính: nộp mỗi đề còn lại đúng một bài và kiểm phiếu nhận bền, có thể chạy lại.
// Kết quả: ba việc chờ cho ba bộ chấm khác nhau; không ghi Portal hoặc dữ liệu thật.
// Khi lỗi: chỉ in mã bước/đề, không in token, bài viết hoặc danh tính.
const base = 'http://127.0.0.1:8790/api/v1/internal/writing-flow/web-substitute';
const token = process.env.WEB_SUBSTITUTE_API_TOKEN;
if (typeof token !== 'string' || token.length < 32
  || process.env.WEB_SUBSTITUTE_ENABLED !== 'true'
  || process.env.WEB_SUBSTITUTE_PORTAL_ENABLED !== 'false') {
  throw new Error('CANARY_CONFIG_NOT_READY');
}

async function api(path, body) {
  const response = await fetch(base + path, {
    method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { http: response.status, body: await response.json() };
}

const cases = [
  { testSlug: 'substitute-test-1-k56', classId: 990056001,
    studentName: 'Học viên giả khóa 56', taskNumber: 2,
    essay: 'Synthetic Task 2 response for staging. Affordable air travel gives more people the chance to visit distant places and reconnect with family. However, more flights increase emissions. I think governments should invest in cleaner aircraft and charge for the pollution they cause, while keeping essential travel accessible.' },
  { testSlug: 'substitute-test-1-k67', classId: 990067001,
    studentName: 'Học viên giả khóa 67', taskNumber: 2,
    essay: 'Synthetic Task 2 response for staging. Celebrities deserve privacy even when they are famous. Reporting on their work can serve the public, but sharing private family details without consent usually causes harm. I agree that the media should leave private matters alone unless there is a clear public interest.' },
  { testSlug: 'substitute-test-2-k67', classId: 990067001,
    studentName: 'Học viên giả khóa 67', taskNumber: 2,
    essay: 'Synthetic Task 2 response for staging. Crowded cities face slow journeys, polluted air and wasted working time. Better buses and trains can reduce dependence on cars. Cities should also plan housing near jobs and limit parking in busy centres. These measures together would make commuting easier and streets healthier.' },
];

function section(correct, type) {
  return { correct, band: 5, total: 40, answered: 40,
    details: Array.from({ length: 40 }, (_, index) => ({
      number: index + 1, studentAnswer: index < correct ? 'A' : 'B',
      correctAnswer: 'A', result: index < correct ? 'correct' : 'incorrect',
    })),
    typeStats: [{ type, correct, total: 40, percentage: correct / 40 }],
  };
}

let current = 'preflight';
try {
  let created = 0;
  let existing = 0;
  for (const entry of cases) {
    current = entry.testSlug;
    const { essay, ...identity } = entry;
    const opened = await api('/attempts', identity);
    if (opened.http !== 200 || opened.body.ok !== true
      || opened.body.attempt?.taskNumber !== identity.taskNumber) {
      throw new Error('CANARY_ATTEMPT_IDENTITY_MISMATCH');
    }
    const submission = { ...identity, attemptId: opened.body.attempt.attemptId,
      essay, sectionResults: {
        listening: section(26, 'Nghe'), reading: section(28, 'Đọc'),
      } };
    const answer = await api('/submissions', submission);
    if (answer.http !== 202 || answer.body.ok !== true
      || answer.body.receipt?.taskNumber !== identity.taskNumber
      || !['pending', 'running', 'completed'].includes(answer.body.receipt.status)) {
      throw new Error('CANARY_RECEIPT_UNCONFIRMED');
    }
    if (answer.body.receipt.status === 'pending') created++;
    else existing++;
    const reopened = await api('/status-by-name', identity);
    if (reopened.http !== 200 || reopened.body.status?.attemptId
      !== opened.body.attempt.attemptId
      || reopened.body.status?.submittedEssay !== essay
      || reopened.body.status?.submissionId !== answer.body.receipt.submissionId) {
      throw new Error('CANARY_REOPEN_MISMATCH');
    }
  }
  process.stdout.write(JSON.stringify({ toolOutcome: 'success',
    businessOutcome: 'verified', source: 'synthetic_only',
    receipts: cases.length, pendingOrCreated: created, existing,
    portalWrites: 0 }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ toolOutcome: 'failure',
    businessOutcome: 'unknown', testSlug: current,
    errorCode: String(error?.message || 'CANARY_UNKNOWN').slice(0, 90) }) + '\n');
  process.exitCode = 1;
}
