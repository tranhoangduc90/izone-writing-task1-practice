const readingLegacyCode = '67-reading-materials-beyond-concrete-matching-information-nen-cap-1';
const readingCodes = [
  readingLegacyCode, '67-reading-homework-butterflies-britain-tfng', '67-reading-green-roofs',
  '67-reading-the-desolenator', '67-reading-athletes-and-stress',
  '67-reading-materials-to-take-us-beyond-concrete-matching-people',
];
const listeningCodes = [
  '67-listening-scandinavian-studies', '67-listening-horton-castle', '67-listening-origami',
  '67-listening-natural-dyes', '67-listening-paper-on-public-libraries',
];
const listeningAnchor = 'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP LISTENING';

function requireAdapter(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function documentParagraphs(document) {
  const paragraphs = [];
  function content(items) {
    for (const item of items || []) {
      if (item.paragraph) {
        paragraphs.push((item.paragraph.elements || []).map(el => el.textRun?.content || '').join(''));
      }
      for (const row of item.table?.tableRows || []) {
        for (const cell of row.tableCells || []) content(cell.content);
      }
    }
  }
  function tabs(items) {
    for (const tab of items || []) {
      content(tab.documentTab?.body?.content);
      tabs(tab.childTabs);
    }
  }
  if (document.tabs?.length) tabs(document.tabs);
  else content(document.body?.content);
  return paragraphs;
}

function exclusiveMarker(paragraphs, codes, errorCode) {
  const found = [];
  for (const code of codes) {
    const mentions = paragraphs.filter(p => p.includes(code));
    if (!mentions.length) continue;
    requireAdapter(mentions.length === 1 && mentions[0].trim() === code, errorCode);
    found.push(code);
  }
  requireAdapter(found.length <= 1, errorCode);
  return found[0] ?? null;
}

export function findK67ReadingHomeworkCode(document, courseId) {
  const code = exclusiveMarker(documentParagraphs(document), readingCodes, 'READING67_CTA_CODE_AMBIGUOUS');
  return code === readingLegacyCode && courseId !== '826336470852' ? null : code;
}

export function findK67ListeningHomeworkCode(document) {
  const paragraphs = documentParagraphs(document);
  return paragraphs.some(p => p.trim() === listeningAnchor)
    ? exclusiveMarker(paragraphs, listeningCodes, 'LISTENING_HW_CODE_AMBIGUOUS')
    : null;
}

export function findK67SpeakingCode(document) {
  const chunks = [];
  let previousParagraph;
  function walk(value, paragraph = null) {
    if (!value || typeof value !== 'object') return;
    const currentParagraph = value.paragraph || paragraph;
    if (value.textRun) {
      if (chunks.length && currentParagraph !== previousParagraph) chunks.push('\n');
      chunks.push(value.textRun.content || '');
      previousParagraph = currentParagraph;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key !== 'textRun') walk(child, currentParagraph);
    }
  }
  walk(document.tabs || document.body);
  const codes = new Set(chunks.join('').match(/(?<![a-z0-9_-])67-speaking-[a-z0-9_-]+/gi) || []);
  requireAdapter(codes.size <= 1, 'SPEAKING_SOURCE_CODE_AMBIGUOUS');
  return codes.values().next().value ?? null;
}

export function buildK67CtaEvent({ source, dispatchToken }) {
  const { documentId, classroom } = source;
  return {
    skip: false, schema_version: 'course67_cta_registration_v2', course: 67,
    cta_dispatch_token: dispatchToken, cta_pipeline_version: 2,
    doc_id: documentId, doc_url: 'https://docs.google.com/document/d/' + documentId + '/edit',
    submission_id: classroom.submissionId, student_id: classroom.studentId,
    classroom_course_id: classroom.courseId, coursework_id: classroom.courseworkId,
    class_name: classroom.classCode, homework_title: classroom.homeworkTitle,
  };
}

// Adapters only report a completed effect after the invoked registrar performs readback.
export function createK67ProductAdapters({ readDocument, readingHomework, listeningHomework,
  readingPractice, listeningPractice, speaking, legacy }) {
  requireAdapter([readDocument, readingHomework, listeningHomework, readingPractice, listeningPractice, speaking, legacy]
    .every(handler => typeof handler === 'function'), 'CTA_ADAPTER_MISSING');
  const absent = event => ({ documentId: event.doc_id, status: 'not_applicable' });
  async function marked(context, product, findCode, register, ackCode) {
    const event = buildK67CtaEvent(context);
    const canReuse = product === 'speaking' && context.nativeReceipts?.get('reading_practice')?.status === 'not_applicable';
    const document = canReuse && context.initialDocument ? context.initialDocument : await readDocument(event.doc_id);
    requireAdapter(document?.documentId === event.doc_id && document.revisionId, 'CTA_DOC_IDENTITY_MISMATCH');
    const code = findCode(document, event.classroom_course_id);
    if (!code) return absent(event);
    await context.assertOwnership();
    const result = await register(event, code, document, context);
    requireAdapter(result?.ok === true && result.documentId === event.doc_id && result.status === 'verified'
      && result.assignmentCode === code, ackCode);
    context.nativeReceipts?.set(product, result);
    return { documentId: event.doc_id, status: 'verified' };
  }
  async function verified(context, product, register, ackCode) {
    const event = buildK67CtaEvent(context);
    await context.assertOwnership();
    const result = await register(event, context);
    requireAdapter(result?.ok !== false && result?.documentId === event.doc_id
      && ['verified', 'not_applicable'].includes(result.status), ackCode);
    context.nativeReceipts?.set(product, result);
    return { documentId: event.doc_id, status: result.status };
  }
  return {
    reading_practice: context => verified(context, 'reading_practice', readingPractice, 'READING_PRACTICE_CTA_READBACK_REQUIRED'),
    speaking: context => marked(context, 'speaking', findK67SpeakingCode, speaking, 'SPEAKING_CTA_READBACK_REQUIRED'),
    listening_homework: context => marked(context, 'listening_homework', findK67ListeningHomeworkCode, listeningHomework, 'LISTENING_HW_CTA_READBACK_REQUIRED'),
    reading_homework: context => marked(context, 'reading_homework', findK67ReadingHomeworkCode, readingHomework, 'READING67_CTA_READBACK_REQUIRED'),
    async legacy(context) {
      const event = buildK67CtaEvent(context);
      await context.assertOwnership();
      const result = await legacy(event, context);
      requireAdapter(result?.documentId === event.doc_id
        && ['verified', 'not_applicable', 'review'].includes(result.status), 'CTA_LEGACY_STAGE_MISSING');
      context.nativeReceipts?.set('legacy', result);
      return result;
    },
    listening_practice: context => verified(context, 'listening_practice', listeningPractice, 'LISTENING_CTA_READBACK_REQUIRED'),
  };
}
