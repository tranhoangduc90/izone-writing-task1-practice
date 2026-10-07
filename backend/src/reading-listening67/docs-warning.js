/**
 * Nhận snapshot Docs và phần bài; lập lệnh thêm/xóa paragraph sau mã bài.
 * Không gọi Google hoặc chấm bài. Ghi lặp không nhân đôi; sau ghi phải readback.
 * Mã lỗi chỉ ra vị trí mơ hồ/revision/nội dung sai, không xóa rộng trong tài liệu.
 */
export const COMPLETION_WARNING = 'Chưa làm đủ 80% khối lượng bài. Hãy bổ sung và nhấn chấm bài lại';
export const CTA_TEXT = 'NHẤN VÀO ĐÂY ĐỂ CHẤM BÀI NGAY';
const legacy = new Set([
  'Hãy hoàn thành bài tập Reading (ít nhất là 80%) để được chấm bài.',
  'Hãy hoàn thành bài tập Listening (ít nhất là 80%) để được chấm bài.',
]);
const error = code => { throw new Error(code); };
function paragraphs(doc) {
  const groups = [], ordered = [];
  function walk(content, tabId) {
    const group = [], ctas = [];
    for (const element of content || []) {
      if (element.paragraph) {
        const runs = element.paragraph.elements || [];
        const p = { element, runs, tabId, text: runs.map(r => r.textRun?.content || '').join(''), plain: runs.every(r => !!r.textRun) };
        p.group = group;
        p.groupIndex = group.length;
        group.push(p);
        ordered.push(p);
        if (p.text.trim() === CTA_TEXT) ctas.push(p);
      } else {
        // Nút CTA hiện hành nằm trong bảng con; mã bài là paragraph sau bảng đó.
        const nestedCtas = [];
        for (const row of element.table?.tableRows || []) for (const cell of row.tableCells || []) nestedCtas.push(...walk(cell.content, tabId));
        group.push({ nestedCtas });
        ctas.push(...nestedCtas);
      }
    }
    groups.push(group);
    return ctas;
  }
  function tabWalk(tabs) {
    for (const tab of tabs || []) {
      walk(tab.documentTab?.body?.content, tab.tabProperties?.tabId || null);
      tabWalk(tab.childTabs);
    }
  }
  if (doc.tabs?.length) tabWalk(doc.tabs); else walk(doc.body?.content, null);
  return ordered;
}
const managed = p => !!p?.plain && (p.text.trim() === COMPLETION_WARNING || legacy.has(p.text.trim()));
function locate(doc, { assignmentCode, tabId }) {
  const hits = [];
  const ordered = paragraphs(doc);
  for (let i = 0; i < ordered.length; i++) {
    const code = ordered[i], previous = ordered[i - 1];
    const cta = previous?.text?.trim() === CTA_TEXT ? previous : null;
    // Mã bài là điểm đặt cảnh báo. CTA có thể nằm ở dòng/bảng trước hoặc không có.
    // Chỉ cảnh báo trong cùng cell/thân ngay sau mã được quản lý, không xóa sang cell khác.
    if (code.text.trim() !== assignmentCode) continue;
    if (tabId != null && code.tabId !== tabId) continue;
    if (!code.plain || !code.text.endsWith('\n')) error('WARNING_ANCHOR_NOT_PLAIN');
    const warnings = [];
    for (let j = code.groupIndex + 1; j < code.group.length && managed(code.group[j]); j++) warnings.push(code.group[j]);
    hits.push({ cta, code, warnings });
  }
  if (hits.length !== 1) error('WARNING_ANCHOR_AMBIGUOUS');
  return hits[0];
}
function withTab(tabId, range) { return tabId ? { ...range, tabId } : range; }
function styled(p) {
  const chars = p.runs.filter(r => r.textRun?.content?.replace(/\n/g, '').length);
  return p.text === COMPLETION_WARNING + '\n' && chars.length > 0 && chars.every(r => {
    const s = r.textRun.textStyle || {}, rgb = s.foregroundColor?.color?.rgbColor;
    return s.bold === true && s.fontSize?.magnitude === 16 && s.fontSize?.unit === 'PT'
      && rgb?.red === 1 && (rgb.green || 0) === 0 && (rgb.blue || 0) === 0 && !s.link && s.underline !== true;
  });
}
export function planCompletionWarning(doc, input) {
  if (!doc.revisionId || doc.documentId !== input.documentId) error('WARNING_DOCUMENT_REVISION_INVALID');
  if (!/^67-(reading-0[1-6]|listening-0[1-5])$/.test(input.assignmentCode)) error('WARNING_ASSIGNMENT_INVALID');
  const { code, warnings } = locate(doc, input);
  const start = code.element.endIndex - 1;
  if (!Number.isInteger(start) || start < 1) error('WARNING_RANGE_INVALID');
  const requests = [];
  const current = warnings.length === 1 && styled(warnings[0]);
  if (warnings.length && (!input.belowThreshold || !current)) {
    // Xóa newline trước cảnh báo và chữ cảnh báo; giữ newline cuối thân/cell.
    const end = warnings.at(-1).element.endIndex - 1;
    if (!Number.isInteger(end) || end <= start) error('WARNING_RANGE_INVALID');
    requests.push({ deleteContentRange: { range: withTab(code.tabId, { startIndex: start, endIndex: end }) } });
  }
  if (input.belowThreshold && !current) {
    requests.push({ insertText: { location: withTab(code.tabId, { index: start }), text: '\n' + COMPLETION_WARNING } });
    requests.push({ updateTextStyle: {
      range: withTab(code.tabId, { startIndex: start + 1, endIndex: start + 1 + COMPLETION_WARNING.length }),
      textStyle: { bold: true, foregroundColor: { color: { rgbColor: { red: 1, green: 0, blue: 0 } } }, fontSize: { magnitude: 16, unit: 'PT' }, underline: false },
      fields: 'bold,foregroundColor,fontSize,underline,link',
    } });
  }
  return { documentId: input.documentId, assignmentCode: input.assignmentCode, tabId: code.tabId,
    belowThreshold: input.belowThreshold, sourceRevisionId: doc.revisionId,
    requests, writeControl: { requiredRevisionId: doc.revisionId } };
}

function nativeState(doc) {
  const tabs = new Map();
  function walk(content, tabId) {
    if (!tabs.has(tabId)) tabs.set(tabId, new Map());
    const chars = tabs.get(tabId);
    for (const e of content || []) {
      for (const r of e.paragraph?.elements || []) {
        if (r.textRun) {
          const text = r.textRun.content || '';
          if (!Number.isInteger(r.startIndex) || r.endIndex - r.startIndex !== text.length) error('WARNING_NATIVE_RANGE_INVALID');
          for (let i = 0; i < text.length; i++) chars.set(r.startIndex + i, { text: text[i] });
        } else {
          if (!Number.isInteger(r.startIndex) || !Number.isInteger(r.endIndex)) error('WARNING_OPAQUE_RANGE_INVALID');
          const object = JSON.stringify(Object.fromEntries(Object.entries(r).filter(([k]) => !['startIndex', 'endIndex'].includes(k))));
          for (let i = r.startIndex; i < r.endIndex; i++) chars.set(i, { object });
        }
      }
      for (const row of e.table?.tableRows || []) for (const cell of row.tableCells || []) walk(cell.content, tabId);
    }
  }
  function tabWalk(list) { for (const tab of list || []) { walk(tab.documentTab?.body?.content, tab.tabProperties?.tabId || ''); tabWalk(tab.childTabs); } }
  if (doc.tabs?.length) tabWalk(doc.tabs); else walk(doc.body?.content, '');
  return tabs;
}
export function verifyCompletionWarning(before, after, plan) {
  if (before.documentId !== plan.documentId || after.documentId !== plan.documentId || before.revisionId !== plan.sourceRevisionId || !after.revisionId) error('WARNING_READBACK_IDENTITY_INVALID');
  const expected = nativeState(before);
  for (const request of plan.requests) {
    const op = request.insertText?.location || request.deleteContentRange?.range;
    if (!op) continue;
    const key = op.tabId || '', chars = expected.get(key);
    if (!chars) error('WARNING_READBACK_TAB_INVALID');
    const next = new Map();
    if (request.insertText) {
      const text = request.insertText.text;
      for (const [i, value] of chars) next.set(i >= op.index ? i + text.length : i, value);
      for (let i = 0; i < text.length; i++) next.set(op.index + i, { text: text[i] });
    } else {
      for (const [i, value] of chars) {
        if (i >= op.startIndex && i < op.endIndex) { if (value.object) error('WARNING_DELETE_OPAQUE_ELEMENT'); continue; }
        next.set(i >= op.endIndex ? i - op.endIndex + op.startIndex : i, value);
      }
    }
    expected.set(key, next);
  }
  const observed = nativeState(after);
  if (expected.size !== observed.size) error('WARNING_READBACK_CONTENT_MISMATCH');
  for (const [tab, chars] of expected) {
    const actual = observed.get(tab);
    if (!actual || actual.size !== chars.size) error('WARNING_READBACK_CONTENT_MISMATCH');
    for (const [i, value] of chars) if (JSON.stringify(actual.get(i)) !== JSON.stringify(value)) error('WARNING_READBACK_CONTENT_MISMATCH');
  }
  const identity = { assignmentCode: plan.assignmentCode, tabId: plan.tabId };
  const original = locate(before, identity), final = locate(after, identity);
  function anchorStyle(p) {
    if (!p) return null;
    return p.runs.flatMap(r => Array.from({ length: r.textRun?.content?.length || 0 }, (_,i) => ({ char: r.textRun.content[i], style: r.textRun.textStyle || {} }))).filter(c => c.char !== '\n');
  }
  for (const key of ['cta', 'code']) if (JSON.stringify(anchorStyle(original[key])) !== JSON.stringify(anchorStyle(final[key]))) error('WARNING_READBACK_ANCHOR_STYLE_CHANGED');
  const { warnings } = final;
  if (plan.belowThreshold ? warnings.length !== 1 || !styled(warnings[0]) : warnings.length !== 0) error('WARNING_READBACK_STYLE_OR_POSITION_INVALID');
  return { warningState: plan.belowThreshold ? 'present_verified' : 'absent_verified', revisionId: after.revisionId, verified: true };
}
