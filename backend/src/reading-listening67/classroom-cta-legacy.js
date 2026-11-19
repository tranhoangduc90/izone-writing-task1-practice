import { isDeepStrictEqual } from 'node:util';

const legacyAnchor = 'NHẤN VÀO ĐÂY ĐỂ CHẤM BÀI NGAY';
const practiceAnchor = 'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP READING';
const practiceCodes = [
  '67-practice-reading_matching_names_sentence_endings_mcq',
  '67-practice-reading_c19_t4_p2_deep_sea_mining',
  '67-practice-reading_c20_t3_p1_frozen_food',
  '67-practice-reading_c21_t1_full_test',
  '67-practice-reading_c21_t2_full_test',
  '67-practice-reading_c21_t3_full_test',
];
const root = 'https://tranhoangduc90.github.io/izone-ai-team-pages/';
const styleKeys = ['link', 'foregroundColor', 'underline'];

function requireLegacy(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function walkDocument(doc) {
  const paragraphs = [];
  function read(items, tabId, parents = []) {
    for (const item of items || []) {
      if (item.paragraph) {
        const runs = item.paragraph.elements || [];
        const raw = runs.map(run => run.textRun?.content || '').join('');
        paragraphs.push({ raw, text: raw.trim(), tabId, parents, runs });
      }
      for (const row of item.table?.tableRows || []) {
        for (const cell of row.tableCells || []) read(cell.content, tabId, [...parents, { table: item.table, cell }]);
      }
    }
  }
  function tabs(list) {
    for (const tab of list || []) {
      requireLegacy(tab.tabProperties?.tabId, 'CTA_LEGACY_TAB_MISSING');
      read(tab.documentTab?.body?.content, tab.tabProperties.tabId);
      tabs(tab.childTabs);
    }
  }
  if (doc.tabs?.length) tabs(doc.tabs);
  else read(doc.body?.content, null);
  return paragraphs;
}

function currentStyle(style, url) {
  const rgb = style?.foregroundColor?.color?.rgbColor;
  return style?.link?.url === url && style?.underline !== true && rgb?.red === 1 && rgb.green === 1 && rgb.blue === 1;
}

function linkFor(paragraph, url) {
  const offset = paragraph.raw.indexOf(paragraph.text);
  const finish = offset + paragraph.text.length;
  let position = 0, startIndex = null, endIndex = null, correct = true;
  for (const run of paragraph.runs) {
    const text = run.textRun?.content ?? '';
    const left = Math.max(position, offset), right = Math.min(position + text.length, finish);
    if (right > left) {
      requireLegacy(Number.isInteger(run.startIndex) && run.startIndex >= 1
        && run.endIndex === run.startIndex + text.length, 'CTA_LEGACY_RANGE_INVALID');
      const from = run.startIndex + left - position;
      requireLegacy(endIndex === null || endIndex === from, 'CTA_LEGACY_RANGE_INVALID');
      startIndex ??= from;
      endIndex = from + right - left;
      correct &&= currentStyle(run.textRun.textStyle, url);
    }
    position += text.length;
  }
  requireLegacy(startIndex !== null && endIndex - startIndex === paragraph.text.length, 'CTA_LEGACY_RANGE_INVALID');
  const range = { startIndex, endIndex, ...(paragraph.tabId ? { tabId: paragraph.tabId } : {}) };
  return { range, url, correct, request: { updateTextStyle: {
    range, fields: styleKeys.join(','), textStyle: {
      link: { url }, underline: false, foregroundColor: { color: { rgbColor: { red: 1, green: 1, blue: 1 } } },
    },
  } } };
}

const normalizedCode = value => value?.text.normalize('NFKC').toLowerCase();

function planOldLinks(paragraphs, event) {
  const registrations = [], links = [], errors = [];
  const codes = new Set(), skills = new Set();
  let position = 0;
  for (const [index, cta] of paragraphs.entries()) {
    if (cta.text !== legacyAnchor) continue;
    position++;
    const next = paragraphs[index + 1];
    const code = normalizedCode(next);
    let skill;
    if (/^67-reading-0[1-6]$/.test(code || '')) skill = 'reading';
    if (/^67-listening-0[1-5]$/.test(code || '')) skill = 'listening';
    if (!skill || next.tabId !== cta.tabId) errors.push('CTA_' + position + '_ASSIGNMENT_CODE_INVALID');
    else if (codes.has(code)) errors.push('CTA_ASSIGNMENT_CODE_DUPLICATE_' + code.replaceAll('-', '_').toUpperCase());
    else if (skills.has(skill)) errors.push('CTA_SKILL_DUPLICATE_' + skill.toUpperCase());
    else {
      const query = new URLSearchParams({ documentId: event.doc_id, assignmentCode: code });
      try {
        links.push(linkFor(cta, root + 'check-now.html?' + query));
      } catch (error) {
        if (error.code !== 'CTA_LEGACY_RANGE_INVALID') throw error;
        errors.push('CTA_' + position + '_RANGE_INVALID');
        continue;
      }
      registrations.push({ assignmentCode: code, ...(cta.tabId ? { tabId: cta.tabId } : {}) });
      codes.add(code);
      skills.add(skill);
    }
  }
  return { links, registrations, errorCode: errors.join('|').slice(0, 200) };
}

function planPracticeLink(paragraphs, event, proof) {
  const matches = paragraphs.map((p, index) => practiceCodes.includes(normalizedCode(p)) ? index : -1).filter(index => index >= 0);
  if (!matches.length) {
    requireLegacy(!paragraphs.some(p => practiceCodes.some(code => normalizedCode(p).includes(code))),
      'READING9_CTA_CODE_POSITION_INVALID');
    return null;
  }
  requireLegacy(matches.length === 1, 'READING9_CTA_CODE_DUPLICATE');
  const codeParagraph = paragraphs[matches[0]], target = paragraphs[matches[0] - 1];
  requireLegacy(target && target.tabId === codeParagraph.tabId && target.text === practiceAnchor, 'READING9_CTA_PAIR_INVALID');
  const codeParent = codeParagraph.parents.at(-1), targetParent = target.parents.at(-1);
  if (codeParent || targetParent) {
    requireLegacy(codeParent && (targetParent?.table === codeParent.table
      || target.parents.some(parent => parent.table === codeParent.table && parent.cell === codeParent.cell)),
    'READING11_CTA_TABLE_PAIR_INVALID');
  }
  const code = normalizedCode(codeParagraph);
  requireLegacy(proof?.documentId === event.doc_id && proof.status === 'verified'
    && proof.code === code && typeof proof.entryUrl === 'string', 'READING_CTA_OWNER_PROOF_REQUIRED');
  const studentUrl = root + 'reading-practice/?' + new URLSearchParams({
    lesson: code, mode: 'student', class: event.class_name, documentId: event.doc_id,
  });
  const confirmationPrefix = root + 'classroom-confirmation/#';
  const validConfirmation = proof.entryMode === 'self-confirmation' && proof.entryUrl.startsWith(confirmationPrefix)
    && /^[0-9a-f-]{36}$/i.test(proof.entryUrl.slice(confirmationPrefix.length));
  requireLegacy(proof.entryUrl === studentUrl || validConfirmation, 'READING_CTA_OWNER_LINK_MISMATCH');
  return linkFor(target, proof.entryUrl);
}

// Keep canonical spans rather than a copy of the style for every character in the document.
function canonicalSpans(doc, links, verify) {
  const byTab = new Map(), covered = new Map(links.map(link => [link, 0]));
  for (const paragraph of walkDocument(doc)) {
    if (!byTab.has(paragraph.tabId)) byTab.set(paragraph.tabId, []);
    const spans = byTab.get(paragraph.tabId);
    for (const run of paragraph.runs) {
      const start = run.startIndex, end = run.endIndex;
      requireLegacy(Number.isInteger(start) && Number.isInteger(end) && end >= start, 'CTA_LEGACY_NATIVE_RANGE_INVALID');
      const applicable = links.filter(({ range }) => (range.tabId ?? null) === paragraph.tabId
        && range.startIndex < end && range.endIndex > start);
      if (!run.textRun) {
        requireLegacy(!applicable.length, 'CTA_LEGACY_OPAQUE_RANGE');
        const { startIndex, endIndex, ...object } = run;
        spans.push({ start, end, object });
        continue;
      }
      const text = run.textRun.content || '';
      requireLegacy(end - start === text.length, 'CTA_LEGACY_NATIVE_RANGE_INVALID');
      const cut = new Set([start, end]);
      for (const { range } of applicable) {
        cut.add(Math.max(start, range.startIndex));
        cut.add(Math.min(end, range.endIndex));
      }
      const offsets = [...cut].sort((a, b) => a - b);
      for (let i = 0; i + 1 < offsets.length; i++) {
        const left = offsets[i], right = offsets[i + 1];
        const link = applicable.find(({ range }) => range.startIndex <= left && range.endIndex >= right);
        const style = { ...run.textRun.textStyle };
        if (link) {
          if (verify) requireLegacy(currentStyle(style, link.url), 'CTA_LEGACY_LINK_NOT_VERIFIED');
          covered.set(link, covered.get(link) + right - left);
          for (const key of styleKeys) delete style[key];
        }
        const section = text.slice(left - start, right - start);
        const previous = spans.at(-1);
        requireLegacy(!previous || previous.end <= left, 'CTA_LEGACY_NATIVE_DUPLICATE');
        if (previous?.end === left && isDeepStrictEqual(previous.style, style)) {
          previous.end = right;
          previous.text += section;
        } else spans.push({ start: left, end: right, text: section, style });
      }
    }
  }
  for (const [link, count] of covered) {
    requireLegacy(count === link.range.endIndex - link.range.startIndex, 'CTA_LEGACY_READBACK_RANGE_INCOMPLETE');
  }
  return byTab;
}

export function createK67LegacyCta({ docs, register, practiceProof }) {
  return async (event, context) => {
    const before = await docs.read(event.doc_id);
    requireLegacy(before?.documentId === event.doc_id && before.revisionId, 'CTA_LEGACY_DOC_IDENTITY_INVALID');
    const paragraphs = walkDocument(before);
    const hasPractice = paragraphs.some(p => practiceCodes.some(code => normalizedCode(p).includes(code)));
    const special = hasPractice ? planPracticeLink(paragraphs, event, await practiceProof(event, context)) : null;
    const old = planOldLinks(paragraphs, event);
    const links = [...(special ? [special] : []), ...(old.errorCode ? [] : old.links)];
    if (!links.length) return { documentId: event.doc_id,
      ...(old.errorCode ? { status: 'review', errorCode: old.errorCode } : { status: 'not_applicable' }) };
    const expected = canonicalSpans(before, links, false);
    await context.assertOwnership();
    for (const destination of old.errorCode ? [] : old.registrations) {
      const result = await register(event, destination, context);
      requireLegacy(result?.ok === true && result.documentId === event.doc_id && result.unitId
        && result.assignmentCode === destination.assignmentCode && (result.tabId || '') === (destination.tabId || ''),
      'RL67_CTA_REGISTER_IDENTITY_MISMATCH');
    }
    const requests = links.filter(link => !link.correct).map(link => link.request);
    let after = before;
    if (requests.length) {
      await context.assertOwnership();
      let writeError;
      try { await docs.write(event.doc_id, { revisionId: before.revisionId, requests }); }
      catch (error) { writeError = error; }
      try { after = await docs.read(event.doc_id); } catch (error) { throw writeError ?? error; }
    }
    requireLegacy(after?.documentId === event.doc_id && after.revisionId, 'CTA_LEGACY_READBACK_IDENTITY');
    requireLegacy(isDeepStrictEqual(expected, canonicalSpans(after, links, true)), 'CTA_LEGACY_CONTENT_OR_STYLE_CHANGED');
    return { documentId: event.doc_id,
      ...(old.errorCode ? { status: 'review', errorCode: old.errorCode }
        : { status: 'verified', entryUrls: links.map(link => link.url) }) };
  };
}
