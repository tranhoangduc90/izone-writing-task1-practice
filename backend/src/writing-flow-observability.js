import crypto from 'node:crypto';

// Nhận vào: yêu cầu Writing và phản hồi HTTP của API.
// Việc chính: ghi một dòng metadata cho mỗi lượt, kể cả lỗi xác thực và lỗi dữ liệu.
// Trả ra: mã truy vết để nối log API với execution n8n và biên nhận trong database.
// Khi lỗi ghi log: không làm hỏng yêu cầu chấm; hệ thống vẫn lưu trạng thái nghiệp vụ trong database.
export function writingFlowRequestLog({ write = line => console.info(line), now = () => Date.now() } = {}) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const sha256 = /^[0-9a-f]{64}$/i;
  const code = /^[A-Z][A-Z0-9_]{0,99}$/;
  const patterns = { pairId: uuid, revision: sha256, stageKey: /^[a-z_]{2,30}$/,
    attemptId: uuid, handoffId: uuid,
    executionId: /^(?:[0-9]{1,20}|trigger-[0-9]{1,20})$/,
    runId: uuid, itemKey: sha256, reviewId: uuid, requestKey: uuid,
    errorCode: code };
  return (req, res, next) => {
    const startedAt = now();
    const requestId = crypto.randomUUID();
    res.set('X-Writing-Request-Id', requestId);
    res.locals.writingRequestId = requestId;
    let logged = false;
    const logOnce = outcome => {
      if (logged) return;
      logged = true;
      const body = req.body && typeof req.body === 'object' ? req.body : {};
      const fields = {
        event: 'writing_flow_api_request',
        requestId,
        method: req.method,
        route: req.route?.path ?? req.baseUrl ?? 'writing-flow',
        outcome,
        status: outcome === 'completed' ? res.statusCode : null,
        durationMs: Math.max(0, now() - startedAt),
      };
      for (const key of Object.keys(patterns)) {
        const value = body[key] ?? (key === 'reviewId' ? req.params?.reviewId : undefined);
        if (typeof value === 'string' && patterns[key].test(value)) fields[key] = value;
      }
      if (code.test(res.locals.writingErrorCode || '')) {
        fields.errorCode = res.locals.writingErrorCode;
      }
      try { write(JSON.stringify(fields)); } catch { /* Nhật ký không được chặn bài. */ }
    };
    res.on('finish', () => logOnce('completed'));
    res.on('close', () => logOnce('connection_closed'));
    next();
  };
}
