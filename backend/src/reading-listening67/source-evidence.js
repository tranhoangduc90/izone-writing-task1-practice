import { createHash } from 'node:crypto';

export const SOURCE_REFERENCE_RULE = 'Trong student_span, trả mã <scope>:<mốc đầu>-<mốc cuối> từ SOURCE_POSITIONS của đúng target_id. Chọn đoạn liên tục. present/contradicted cần mã. absent cần null, uncertain có thể null.';

export function indexSourceEvidence({ operationId, sourceVersion, targetId, text }) {
  if (typeof text !== 'string') {
    throw Object.assign(new Error('Thiếu câu trả lời thô của ô đang chấm.'), {
      code: 'SOURCE_SNAPSHOT_MISSING',
    });
  }
  const scope = createHash('sha256')
    .update(JSON.stringify([operationId, sourceVersion, targetId, text]))
    .digest('hex').slice(0, 32);
  const marks = [...text.matchAll(/[\p{L}\p{M}\p{N}]+|[^\s]/gu)].map(match => ({
    start: match.index,
    end: match.index + match[0].length,
    text: match[0],
  }));
  return { scope, text, marks };
}

export function resolveSourceEvidence(source, reference) {
  if (!source) return { code: 'SOURCE_SNAPSHOT_MISSING' };
  if (reference == null || reference === '') return { code: 'SOURCE_REF_MISSING' };
  const parts = typeof reference === 'string' && /^([a-f0-9]{32}):([1-9][0-9]{0,4})-([1-9][0-9]{0,4})$/.exec(reference);
  if (!parts) return { code: 'SOURCE_REF_INVALID' };
  const [, scope, from, to] = parts;
  if (scope !== source.scope) return { code: 'SOURCE_VERSION_MISMATCH' };
  const first = source.marks[Number(from) - 1];
  const last = source.marks[Number(to) - 1];
  if (!first || !last || first.start > last.start) return { code: 'SOURCE_REF_INVALID' };
  return { text: source.text.slice(first.start, last.end) };
}

export function sourceEvidencePositions(source) {
  return { scope: source.scope, marks: source.marks.map(({ text }, index) => [index + 1, text]) };
}
