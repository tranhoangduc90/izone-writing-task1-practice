import { indexSourceEvidence, resolveSourceEvidence, sourceEvidencePositions } from '../reading-listening67/source-evidence.js';

export const LISTENING_SOURCE_VERSION = 'listening-homework-source-references-v1';

export const listeningSourceInstructions = 'Trường span trong units và meaning_errors nhận mã <scope>:<mốc đầu>-<mốc cuối> từ source_positions của đúng target_id. Chọn đoạn liên tục, gồm cả mốc cuối. Không chép chữ vào span. Với hai đoạn giống chữ, chọn đúng lần xuất hiện. Máy chủ lấy nguyên văn từ bài nộp. Candidate ở lượt review là kết quả đã giải mã và chỉ dùng để đối chiếu. Mọi span mới trong meaning_errors của review vẫn phải dùng mã.';

export function listeningEvidenceSource(item, operationId, sourceVersion) {
  return indexSourceEvidence({ operationId, sourceVersion, targetId: item.id, text: item.response });
}

export { sourceEvidencePositions };

function materializeSpan(source, reference, field, mustBeNull = false) {
  if (mustBeNull && reference === null) return null;
  const resolved = mustBeNull && reference != null
    ? { code: 'SOURCE_REF_INVALID' }
    : resolveSourceEvidence(source, reference);
  if (resolved.code) {
    throw Object.assign(new Error('Chọn hai mốc hợp lệ của đúng ô đang chấm cho ' + field + '.'), {
      code: resolved.code,
    });
  }
  return resolved.text;
}

export function materializeListeningSpans(row, source, phase) {
  const meaningErrors = Array.isArray(row.meaning_errors) ? row.meaning_errors.map((error, index) => ({
    ...error, span: materializeSpan(source, error?.span, `meaning_errors[${index}].span`),
  })) : row.meaning_errors;
  if (phase === 'review' || !Array.isArray(row.units)) return { ...row, meaning_errors: meaningErrors };
  const units = row.units.map((unit, index) => {
    if (!['present', 'contradicted', 'absent', 'uncertain'].includes(unit?.status)) return unit;
    const mustBeNull = ['absent', 'uncertain'].includes(unit.status);
    return { ...unit, span: materializeSpan(source, unit.span, `units[${index}].span`, mustBeNull) };
  });
  return { ...row, units, meaning_errors: meaningErrors };
}
