import { ApiError } from './service.js';

const LMS_APP_HOST = 'practice.izone.edu.vn';
const LMS_API_ORIGIN = 'https://quickaid.izone.edu.vn';
const LMS_API_PATH = '/v1/writing-essays/';
const MAX_UPSTREAM_BYTES = 4 * 1024 * 1024;
const MAX_NORMALIZED_BYTES = 2 * 1024 * 1024;
const MAX_ESSAYS = 80;
const MAX_NODES_PER_DOCUMENT = 800;
const MAX_TEXT_PER_DOCUMENT = 25_000;
const MAX_COMMENTS_PER_ESSAY = 20;
const MAX_COMMENT_TEXT = 20_000;
const ALLOWED_NODE_TYPES = new Set(['doc', 'paragraph', 'heading', 'text', 'hardBreak', 'bulletList', 'orderedList', 'listItem']);

function groupIdFromLmsUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== LMS_APP_HOST) return null;
    const match = url.pathname.match(/^\/shared\/writing-essays\/([a-z0-9_-]{8,100})\/(?:edit|view)\/?$/iu);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function clip(value, limit) {
  return typeof value === 'string' ? value.slice(0, limit) : '';
}

function normalizeDocument(value) {
  let nodes = 0;
  let textLength = 0;

  const visit = (node) => {
    if (!node || typeof node !== 'object' || nodes >= MAX_NODES_PER_DOCUMENT) return null;
    const type = ALLOWED_NODE_TYPES.has(node.type) ? node.type : null;
    if (!type) return null;
    nodes += 1;
    if (type === 'text') {
      const remaining = MAX_TEXT_PER_DOCUMENT - textLength;
      if (remaining <= 0) return null;
      const text = clip(node.text, remaining);
      textLength += text.length;
      return {
        type: 'text',
        text,
        ...(Array.isArray(node.marks) && node.marks.some(mark => mark?.type === 'highlight')
          ? { marks: [{ type: 'highlight' }] }
          : {})
      };
    }
    const content = Array.isArray(node.content) ? node.content.map(visit).filter(Boolean) : [];
    return { type, ...(content.length ? { content } : {}) };
  };

  return visit(value) || { type: 'doc', content: [] };
}

export function normalizeLmsResult(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.essays)) {
    throw new ApiError(502, 'LMS_RESULT_INVALID', 'Kết quả LMS chưa đúng định dạng.');
  }
  const essays = payload.essays.slice(0, MAX_ESSAYS).filter(item => item && typeof item === 'object').map((essay, position) => {
    let commentLength = 0;
    const comments = (Array.isArray(essay.comments) ? essay.comments : []).slice(0, MAX_COMMENTS_PER_ESSAY).map((comment) => {
      const remaining = Math.max(0, 30_000 - commentLength);
      const text = clip(comment, Math.min(MAX_COMMENT_TEXT, remaining));
      commentLength += text.length;
      return text;
    }).filter(Boolean);
    return {
      id: clip(essay.id, 120) || `sentence-${position + 1}`,
      index: Number.isInteger(essay.index) && essay.index >= 0 ? essay.index : position,
      content: normalizeDocument(essay.content),
      suggestedContent: normalizeDocument(essay.suggestedContent),
      comments
    };
  }).sort((left, right) => left.index - right.index);
  const result = { essays };
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_NORMALIZED_BYTES) {
    throw new ApiError(502, 'LMS_RESULT_TOO_LARGE', 'Kết quả LMS quá lớn để hiển thị an toàn.');
  }
  return result;
}

export function createLmsResultService({ pool, fetchImpl = globalThis.fetch, timeoutMs = 8_000 }) {
  if (typeof fetchImpl !== 'function') throw new Error('Fetch API không khả dụng.');

  async function getDraftResult({ sessionRef }) {
    const stored = await pool.query(`SELECT attempt.result_artifacts->>'lmsUrl' AS "lmsUrl",
        attempt.completed_at AS "updatedAt"
      FROM writing_practice.activity_session session
      JOIN writing_practice.check_attempt attempt ON attempt.session_id=session.id
      WHERE session.public_id=$1 AND attempt.section_key='draft'
        AND attempt.status='completed' AND attempt.result_status='passed'
        AND attempt.result_artifacts ? 'lmsUrl'
      ORDER BY attempt.completed_at DESC NULLS LAST, attempt.id DESC
      LIMIT 1`, [sessionRef]);
    if (!stored.rowCount) throw new ApiError(404, 'DRAFT_RESULT_NOT_FOUND', 'Chưa có kết quả chấm Draft.');
    const groupId = groupIdFromLmsUrl(stored.rows[0].lmsUrl);
    if (!groupId) throw new ApiError(502, 'LMS_URL_INVALID', 'Link LMS đã lưu không hợp lệ.');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    let bytes;
    try {
      const url = new URL(`${LMS_API_PATH}${encodeURIComponent(groupId)}`, LMS_API_ORIGIN);
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal
      });
      if (!response.ok) throw new ApiError(502, 'LMS_UNAVAILABLE', 'Tạm thời chưa tải được kết quả LMS.');
      const declaredLength = Number(response.headers.get('content-length') || 0);
      if (declaredLength > MAX_UPSTREAM_BYTES) throw new ApiError(502, 'LMS_RESULT_TOO_LARGE', 'Kết quả LMS quá lớn để hiển thị an toàn.');
      bytes = Buffer.from(await response.arrayBuffer());
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'LMS_UNAVAILABLE', 'Tạm thời chưa tải được kết quả LMS.');
    } finally {
      clearTimeout(timer);
    }
    if (bytes.length > MAX_UPSTREAM_BYTES) throw new ApiError(502, 'LMS_RESULT_TOO_LARGE', 'Kết quả LMS quá lớn để hiển thị an toàn.');
    let payload;
    try {
      payload = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new ApiError(502, 'LMS_RESULT_INVALID', 'Kết quả LMS chưa đúng định dạng.');
    }
    return { ...normalizeLmsResult(payload), updatedAt: stored.rows[0].updatedAt };
  }

  return { getDraftResult };
}
