// Dữ liệu vào: bốn bài giả đã nộp và chấm qua API/n8n trong Writing staging.
// Việc chính: mở lại theo đúng tên–lớp–đề, so Task/rubric/tiêu chí và chặn tên khác.
// Kết quả: bằng chứng bốn nguồn đều trả kết quả đúng, không ghi Portal.
// Khi lỗi: chỉ in tên phép kiểm và mã đề; không in bài, feedback hoặc token.
const token = process.env.WEB_SUBSTITUTE_API_TOKEN;
const url = 'http://127.0.0.1:8790/api/v1/internal/writing-flow/web-substitute/status-by-name';
if (typeof token !== 'string' || token.length < 32) throw new Error('CANARY_TOKEN_MISSING');

async function status(identity) {
  const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(identity),
  });
  return { http: response.status, value: await response.json() };
}

const cases = [
  { testSlug: 'substitute-test-1-k56', classId: 990056001,
    studentName: 'Học viên giả khóa 56', taskNumber: 2,
    prefix: 'Synthetic Task 2 response for staging.', components: 10 },
  { testSlug: 'substitute-test-2-k56', classId: 990056001,
    studentName: 'Học viên giả khóa 56', taskNumber: 1,
    prefix: 'Synthetic Task 1 report for staging.', components: 9 },
  { testSlug: 'substitute-test-1-k67', classId: 990067001,
    studentName: 'Học viên giả khóa 67', taskNumber: 2,
    prefix: 'Synthetic Task 2 response for staging.', components: 10 },
  { testSlug: 'substitute-test-2-k67', classId: 990067001,
    studentName: 'Học viên giả khóa 67', taskNumber: 2,
    prefix: 'Synthetic Task 2 response for staging.', components: 10 },
];

let current = 'preflight';
try {
  const grades = [];
  for (const entry of cases) {
    current = entry.testSlug;
    const { prefix, components, taskNumber, ...identity } = entry;
    const own = await status(identity);
    const row = own.value.status;
    const actualComponents = Array.isArray(row?.result?.criteria)
      ? row.result.criteria.reduce((sum, item) => sum + (item.components?.length || 0), 0)
      : 0;
    const checks = {
      http: own.http === 200 && own.value.ok === true,
      lifecycle: row?.attemptStatus === 'completed'
        && row?.submissionStatus === 'completed',
      task: row?.taskNumber === taskNumber
        && row?.result?.taskNumber === taskNumber,
      score: Number.isFinite(row?.taskScore) && row.taskScore >= 0
        && row.taskScore <= 9 && row.result?.taskScore === row.taskScore,
      rubric: typeof row?.rubricVersion === 'string' && row.rubricVersion.length > 0,
      criteria: row?.result?.criteria?.length === 4
        && actualComponents === components,
      essay: row?.submittedEssay?.startsWith(prefix) === true,
      sections: row?.sectionResults?.listening?.correct === 26
        && row?.sectionResults?.reading?.correct === 28,
      portal: row?.portalSyncStatus === 'not_applicable',
    };
    const failed = Object.entries(checks).filter(([, passed]) => !passed)
      .map(([name]) => name);
    if (failed.length) throw new Error(`CANARY_RESULT_MISMATCH:${failed.join(',')}`);
    grades.push({ testSlug: entry.testSlug, taskNumber,
      taskScore: row.taskScore, components: actualComponents });
    const other = await status({ ...identity, studentName: 'Tên không có trong lớp' });
    if (other.http !== 404 || other.value.status !== undefined) {
      throw new Error('CANARY_WRONG_NAME_EXPOSED');
    }
  }
  process.stdout.write(JSON.stringify({ toolOutcome: 'success',
    businessOutcome: 'verified', source: 'synthetic_only',
    results: grades, otherNameBlocked: true, portalWrites: 0 }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ toolOutcome: 'failure',
    businessOutcome: 'unknown', testSlug: current,
    errorCode: String(error?.message || 'CANARY_UNKNOWN').slice(0, 90) }) + '\n');
  process.exitCode = 1;
}
