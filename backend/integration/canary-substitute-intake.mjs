// Dữ liệu vào: bốn cặp lớp–đề giả trong kho staging và token ở environment của canary.
// Việc chính: thử mở lượt, nộp lặp, chặn sửa bài và mở lại theo tên qua HTTP thật.
// Kết quả: chỉ một bài giả chờ chấm, ba lượt còn mở; không gọi AI hoặc Portal.
// Khi lỗi: in mã bước, không in khóa hay nội dung bài rồi dừng để đối soát.
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

function insist(condition, code) {
  if (!condition) throw new Error(code);
}

const cases = [
  { testSlug: 'substitute-test-1-k56', classId: 990056001,
    studentName: 'Học viên giả khóa 56', taskNumber: 2 },
  { testSlug: 'substitute-test-2-k56', classId: 990056001,
    studentName: 'Học viên giả khóa 56', taskNumber: 1 },
  { testSlug: 'substitute-test-1-k67', classId: 990067001,
    studentName: 'Học viên giả khóa 67', taskNumber: 2 },
  { testSlug: 'substitute-test-2-k67', classId: 990067001,
    studentName: 'Học viên giả khóa 67', taskNumber: 2 },
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

try {
  const opened = [];
  for (const identity of cases) {
    const before = await api('/status-by-name', identity);
    insist(before.http === 200 && before.body.ok === true
      && before.body.status === null, 'CANARY_STATUS_BEFORE_NOT_EMPTY');
    const result = await api('/attempts', identity);
    insist(result.http === 200 && result.body.ok === true
      && result.body.attempt?.taskNumber === identity.taskNumber,
    'CANARY_OPEN_IDENTITY_MISMATCH');
    opened.push({ ...identity, attemptId: result.body.attempt.attemptId });
  }
  const target = opened[1];
  const essay = 'Synthetic Task 1 report for staging. The three pizza places changed over time.';
  const submission = { ...target, essay, sectionResults: {
    listening: section(26, 'Nghe'), reading: section(28, 'Đọc'),
  } };
  const first = await api('/submissions', submission);
  insist(first.http === 202 && first.body.ok === true
    && first.body.receipt?.taskNumber === 1
    && first.body.receipt?.status === 'pending', 'CANARY_RECEIPT_UNCONFIRMED');
  const again = await api('/submissions', submission);
  insist(again.http === 202 && again.body.receipt?.submissionId
    === first.body.receipt.submissionId, 'CANARY_DUPLICATE_RECEIPT_CHANGED');
  const conflict = await api('/submissions', { ...submission, essay: essay + ' Modified.' });
  insist(conflict.http === 409 && conflict.body.error === 'WEB_SUBMISSION_CONFLICT',
    'CANARY_DIFFERENT_CONTENT_ACCEPTED');
  const reopened = await api('/status-by-name', target);
  insist(reopened.http === 200 && reopened.body.status?.attemptId === target.attemptId
    && reopened.body.status?.submissionId === first.body.receipt.submissionId
    && reopened.body.status?.submittedEssay === essay
    && reopened.body.status?.submissionStatus === 'pending',
  'CANARY_REOPEN_BY_NAME_MISMATCH');
  const other = await api('/status-by-name', { ...target, studentName: 'Tên không có trong lớp' });
  insist(other.http === 404 && other.body.status === undefined,
    'CANARY_OTHER_NAME_CAN_READ');
  process.stdout.write(JSON.stringify({ toolOutcome: 'success', businessOutcome: 'verified',
    source: 'synthetic_only', openedAttempts: opened.length,
    durableSubmissions: 1, duplicateReceiptSame: true,
    differentContentBlocked: true, reopenedByName: true,
    otherNameBlocked: true, portalWrites: 0 }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ toolOutcome: 'failure', businessOutcome: 'unknown',
    errorCode: String(error?.message || 'CANARY_UNKNOWN').slice(0, 90) }) + '\n');
  process.exitCode = 1;
}
