// Dữ liệu vào: bài Task 1 giả đã chấm qua n8n và API canary trong staging.
// Việc chính: mở lại chỉ bằng tên, so Task/điểm/bốn tiêu chí/bài đã nộp.
// Kết quả: người chọn tên đúng thấy kết quả; không ghi Portal hoặc in feedback.
// Khi lỗi: dừng và chỉ in mã bước, không in token/bài hay nhận xét.
const token = process.env.WEB_SUBSTITUTE_API_TOKEN;
const url = 'http://127.0.0.1:8790/api/v1/internal/writing-flow/web-substitute/status-by-name';
if (typeof token !== 'string' || token.length < 32) throw new Error('CANARY_TOKEN_MISSING');

async function status(studentName) {
  const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(10000),
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ testSlug: 'substitute-test-2-k56', classId: 990056001,
      studentName }),
  });
  return { http: response.status, value: await response.json() };
}

try {
  const own = await status('Học viên giả khóa 56');
  const row = own.value.status;
  const criteria = row?.result?.criteria;
  const components = Array.isArray(criteria)
    ? criteria.reduce((sum, item) => sum + (item.components?.length || 0), 0) : 0;
  const checks = {
    http: own.http === 200,
    response: own.value.ok === true,
    attempt: row?.attemptStatus === 'completed',
    submission: row?.submissionStatus === 'completed',
    task: row?.taskNumber === 1 && row?.result?.taskNumber === 1,
    score: Number.isFinite(row?.taskScore) && row.taskScore >= 0
      && row.taskScore <= 9 && row.result?.taskScore === row.taskScore,
    criteria: criteria?.length === 4,
    components: components === 9,
    essay: row?.submittedEssay?.startsWith('Synthetic Task 1 report for staging.') === true,
    listening: row?.sectionResults?.listening?.correct === 26,
    reading: row?.sectionResults?.reading?.correct === 28,
    portal: row?.portalSyncStatus === 'not_applicable',
  };
  const failedChecks = Object.entries(checks).filter(([, passed]) => !passed)
    .map(([name]) => name);
  if (failedChecks.length) {
    throw new Error(`CANARY_RESULT_READBACK_MISMATCH:${failedChecks.join(',')}`);
  }
  const other = await status('Tên không có trong lớp');
  if (other.http !== 404 || other.value.status !== undefined) {
    throw new Error('CANARY_RESULT_WRONG_NAME_EXPOSED');
  }
  process.stdout.write(JSON.stringify({ toolOutcome: 'success', businessOutcome: 'verified',
    source: 'synthetic_only', testSlug: 'substitute-test-2-k56', taskNumber: 1,
    taskScore: row.taskScore, criteriaCount: criteria.length,
    componentCount: components, essayRestored: true,
    sectionsRestored: true, otherNameBlocked: true,
    portalStatus: row.portalSyncStatus }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ toolOutcome: 'failure', businessOutcome: 'unknown',
    errorCode: String(error?.message || 'CANARY_UNKNOWN').slice(0, 90) }) + '\n');
  process.exitCode = 1;
}
