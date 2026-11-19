import { findK67SpeakingCode } from './classroom-cta-adapters.js';

const codes = new Set([
  '67-speaking-paraphrase', '67-speaking-lam_ro', '67-speaking-diem_giua', '67-speaking-on_tap_lam_ro_diem_giua',
  '67-speaking-ly_do_hanh_vi', '67-speaking-cach_lam_mot_viec', '67-speaking-so_sanh', '67-speaking-freestyle_on_tap',
  '67-speaking-ke_chuyen_boi_canh_truoc_trong_sau', '67-speaking-ke_chuyen_dien_bien_chi_tiet',
  '67-speaking-ke_chuyen_ket_cuc_y_nghia', '67-speaking-ta_vat_gioi_thieu_mieu_ta', '67-speaking-ta_nguoi',
  '67-speaking-ta_vat_mieu_ta_chuc_nang_what_if',
]);
const numericId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const documentId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{5,120}$/.test(value);
const anchor = 'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP SPEAKING';

function requireSpeaking(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

export function parseK67SpeakingScopes(response) {
  requireSpeaking(response?.ok === true && Array.isArray(response.assignments) && response.assignments.length <= 200,
    'SPEAKING_ASSIGNMENT_SCOPES_INVALID');
  const seen = new Set();
  return response.assignments.map(row => {
    const key = row.course_id + ':' + row.course_work_id;
    requireSpeaking(numericId(row.course_id) && numericId(row.course_work_id)
      && codes.has(row.assignment_code) && ['direct', 'docs_cta'].includes(row.delivery_mode)
      && /^[A-Za-z0-9._-]{1,32}$/.test(row.class_code)
      && (row.delivery_mode === 'direct' && row.opened_at === null
        || typeof row.opened_at === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(row.opened_at)
          && Number.isFinite(Date.parse(row.opened_at))), 'SPEAKING_ASSIGNMENT_SCOPE_INVALID');
    requireSpeaking(!seen.has(key), 'SPEAKING_ASSIGNMENT_SCOPE_DUPLICATE');
    seen.add(key);
    return { courseId: row.course_id, courseWorkId: row.course_work_id, assignmentCode: row.assignment_code,
      classCode: row.class_code, deliveryMode: row.delivery_mode, openedAt: row.opened_at };
  });
}

function copySnapshot(scope, snapshot) {
  requireSpeaking(snapshot?.courseId === scope.courseId && snapshot.courseWorkId === scope.courseWorkId
    && snapshot.assignmentCode === scope.assignmentCode, 'SPEAKING_SNAPSHOT_IDENTITY_MISMATCH');
  requireSpeaking(snapshot.status === 'snapshot' && snapshot.classroomState === 'PUBLISHED'
    && Array.isArray(snapshot.submissions) && snapshot.submissions.length <= 100, 'SPEAKING_SNAPSHOT_INCOMPLETE');
  const ids = new Set(), docs = new Set();
  for (const row of snapshot.submissions) {
    requireSpeaking(numericId(row.userId) && typeof row.id === 'string' && row.id.length > 0
      && !ids.has(row.id) && (row.documentId === null || documentId(row.documentId) && !docs.has(row.documentId)),
    'SPEAKING_SNAPSHOT_COPY_INVALID');
    ids.add(row.id);
    if (row.documentId) docs.add(row.documentId);
  }
  return { courseId: scope.courseId, courseWorkId: scope.courseWorkId,
    snapshotComplete: true, submissions: snapshot.submissions };
}

function validatePlan(plan, document, { id, classCode, assignmentCode }) {
  requireSpeaking(plan?.documentId === id && plan.revisionId === document.revisionId
    && typeof plan.url === 'string' && Array.isArray(plan.requests) && plan.requests.length <= 1,
  'SPEAKING_PLAN_INVALID');
  let href;
  try { href = new URL(plan.url); } catch { requireSpeaking(false, 'SPEAKING_PLAN_LINK_MISMATCH'); }
  requireSpeaking(href.origin === 'https://tranhoangduc90.github.io' && !href.username && !href.password
    && /^\/izone-ai-team-pages\/speaking-homework\/(?:lesson-[0-9]+\.html)?$/.test(href.pathname)
    && href.searchParams.get('documentId') === id && href.searchParams.get('class') === classCode
    && href.searchParams.get('assignmentCode') === assignmentCode, 'SPEAKING_PLAN_LINK_MISMATCH');
  if (!plan.requests.length) return;
  const request = plan.requests[0], update = request?.updateTextStyle;
  requireSpeaking(update && Object.keys(request).length === 1 && update.textStyle?.link?.url === plan.url
    && Object.keys(update.textStyle).sort().join(',') === 'foregroundColor,link,underline'
    && String(update.fields).split(',').sort().join(',') === 'foregroundColor,link,underline',
  'SPEAKING_PLAN_WRITE_INVALID');
  const hits = [];
  function walk(value, tabId) {
    if (!value || typeof value !== 'object') return;
    const tab = value.tabProperties?.tabId || tabId;
    if (value.textRun?.content?.includes(anchor)) {
      hits.push({ tabId: tab, startIndex: value.startIndex + value.textRun.content.indexOf(anchor) });
    }
    for (const [key, child] of Object.entries(value)) if (key !== 'textRun') walk(child, tab);
  }
  walk(document.tabs || document.body, null);
  requireSpeaking(hits.length === 1 && hits[0].tabId && Number.isInteger(hits[0].startIndex) && hits[0].startIndex >= 1
    && update.range?.tabId === hits[0].tabId && update.range.startIndex === hits[0].startIndex
    && update.range.endIndex === hits[0].startIndex + anchor.length, 'SPEAKING_PLAN_RANGE_MISMATCH');
}

export function createK67SpeakingCta({ api, docs, lockDocument, ownsScope, getSnapshot, log = () => {} }) {
  async function sync(scope, snapshot) {
    const payload = copySnapshot(scope, snapshot);
    const result = await api.sync(payload);
    requireSpeaking(Array.isArray(result?.pending) && result.pending.length <= payload.submissions.length,
      'SPEAKING_SYNC_INVALID');
    const seen = new Set();
    const pending = result.pending.map(row => {
      const source = payload.submissions.find(item => item.documentId === row.documentId
        && item.id === row.classroomSubmissionId);
      requireSpeaking(source && !seen.has(row.documentId) && row.assignmentCode === scope.assignmentCode
        && row.classCode === scope.classCode, 'SPEAKING_SYNC_IDENTITY_MISMATCH');
      seen.add(row.documentId);
      return source;
    });
    return { pending };
  }

  async function writeLink(id, scope, context, before) {
    const { assignmentCode } = scope;
    const initial = before ?? await docs.read(id);
    requireSpeaking(initial?.documentId === id && initial.revisionId, 'SPEAKING_DOC_ID_MISMATCH');
    requireSpeaking(findK67SpeakingCode(initial) === assignmentCode, 'SPEAKING_EVENT_CODE_MISMATCH');
    const plan = await api.plan({ documentId: id, document: initial });
    validatePlan(plan, initial, { id, ...scope });
    let current = initial;
    if (plan.requests.length) {
      await context.assertOwnership();
      try { await docs.write(id, plan); }
      catch (error) {
        current = await docs.read(id);
        const readback = await api.plan({ documentId: id, document: current });
        validatePlan(readback, current, { id, ...scope });
        if (readback.requests.length !== 0) throw error;
      }
      if (current === initial) current = await docs.read(id);
    }
    requireSpeaking(current?.documentId === id && current.revisionId, 'SPEAKING_CTA_READBACK_REQUIRED');
    await context.assertOwnership();
    const proof = await api.verify({ documentId: id, document: current });
    requireSpeaking(proof?.documentId === id && proof.verified === true
      && ['linked', 'pending'].includes(proof.status), 'SPEAKING_CTA_READBACK_REQUIRED');
    return { documentId: id, ok: true, status: 'verified', assignmentCode, entryUrl: plan.url };
  }

  return {
    async event(event, assignmentCode, document, context) {
      requireSpeaking(codes.has(assignmentCode), 'SPEAKING_ASSIGNMENT_SCOPE_INVALID');
      const scope = { courseId: event.classroom_course_id, courseWorkId: event.coursework_id,
        classCode: event.class_name, assignmentCode, deliveryMode: 'docs_cta' };
      const snapshot = await getSnapshot(scope, context);
      const source = copySnapshot(scope, snapshot).submissions.find(row => row.id === event.submission_id);
      requireSpeaking(source?.documentId === event.doc_id && source.userId === event.student_id,
        'SPEAKING_EVENT_NOT_IN_CLASSROOM');
      const registered = parseK67SpeakingScopes(await api.scopes())
        .find(row => row.courseId === scope.courseId && row.courseWorkId === scope.courseWorkId);
      if (registered) requireSpeaking(registered.assignmentCode === assignmentCode && registered.classCode === scope.classCode
        && registered.deliveryMode === 'docs_cta', 'SPEAKING_ASSIGNMENT_SCOPE_MISMATCH');
      else {
        await context.assertOwnership();
        const saved = await api.register({ courseId: scope.courseId, courseWorkId: scope.courseWorkId,
          assignmentCode, title: event.homework_title, classroomState: 'PUBLISHED' });
        requireSpeaking(saved?.registered === true && saved.status === 'open' && saved.classCode === scope.classCode,
          'SPEAKING_ASSIGNMENT_NOT_OPEN');
      }
      await context.assertOwnership();
      await sync(scope, snapshot);
      return writeLink(event.doc_id, scope, context, document);
    },
    async reconcile(scope, snapshot, epoch) {
      requireSpeaking(snapshot?.courseId === scope.courseId && snapshot.courseWorkId === scope.courseWorkId
        && snapshot.assignmentCode === scope.assignmentCode, 'SPEAKING_SNAPSHOT_IDENTITY_MISMATCH');
      const assertOwnership = async () => requireSpeaking(await ownsScope({ ...scope, epoch }) === true, 'CTA_SCOPE_NOT_OWNED');
      await assertOwnership();
      if (snapshot.classroomState === 'DELETED' && snapshot.status === 'not_published') {
        const saved = await api.register({ courseId: scope.courseId, courseWorkId: scope.courseWorkId,
          assignmentCode: scope.assignmentCode, classroomState: 'DELETED' });
        requireSpeaking(saved?.registered === true && saved.status === 'closed', 'SPEAKING_CLOSE_NOT_VERIFIED');
        return { status: 'closed', verified: 0 };
      }
      if (snapshot.classroomState === 'DRAFT' && snapshot.status === 'not_published'
        || snapshot.classroomState === 'PUBLISHED' && snapshot.status === 'direct' && scope.deliveryMode === 'direct') {
        return { status: 'skipped', verified: 0 };
      }
      const { pending } = await sync(scope, snapshot);
      let verified = 0;
      const errors = [];
      for (const row of pending) {
        try {
          await lockDocument(row.documentId, async () => {
            await assertOwnership();
            await writeLink(row.documentId, scope, { assertOwnership });
          });
          verified++;
        } catch (error) {
          const code = /^[A-Z0-9_]{1,100}$/.test(error.code || '') ? error.code : 'SPEAKING_COPY_FAILED';
          errors.push(code);
          log({ stage: 'speaking_copy', classCode: scope.classCode, assignmentCode: scope.assignmentCode, errorCode: code });
        }
      }
      return { status: errors.length ? 'partial' : 'done', verified, errors };
    },
  };
}
