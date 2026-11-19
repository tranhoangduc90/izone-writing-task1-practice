import assert from 'node:assert/strict';
import test from 'node:test';
import { createK67SpeakingCta, parseK67SpeakingScopes } from '../src/reading-listening67/classroom-cta-speaking.js';

const id = 'fixture_document_123456789012345';
const courseId = '100', courseWorkId = '200', classCode = 'IC2353';
const assignmentCode = '67-speaking-paraphrase';
const anchor = 'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP SPEAKING';
const submissions = [{ id: '300', userId: '400', documentId: id }];
const scope = { courseId, courseWorkId, classCode, assignmentCode, deliveryMode: 'docs_cta' };
const snapshot = { courseId, courseWorkId, assignmentCode, status: 'snapshot', classroomState: 'PUBLISHED', submissions };
const event = { classroom_course_id: courseId, coursework_id: courseWorkId, class_name: classCode,
  doc_id: id, submission_id: '300', student_id: '400', homework_title: 'QA Lesson 2' };
const registry = { course_id: courseId, course_work_id: courseWorkId, class_code: classCode,
  assignment_code: assignmentCode, delivery_mode: 'docs_cta', opened_at: '2026-11-19T06:00:00Z' };
const proofUrl = 'https://tranhoangduc90.github.io/izone-ai-team-pages/speaking-homework/?' + new URLSearchParams({
  documentId: id, class: classCode, assignmentCode,
});

test('job Speaking xác minh đúng bản sao, không ghi lại link đúng và chỉ đóng theo DELETED rõ ràng', async () => {
  const calls = [];
  let changed = false;
  let wrongRange = true;
  const doc = () => ({ documentId: id, revisionId: changed ? 'r2' : 'r1', tabs: [{
    tabProperties: { tabId: 't.0' }, documentTab: { body: { content: [
      { paragraph: { elements: [{ startIndex: 1, textRun: { content: assignmentCode + '\n' } }] } },
      { paragraph: { elements: [{ startIndex: 23, textRun: { content: anchor + '\n' } }] } },
    ] } },
  }] });
  const service = createK67SpeakingCta({
    getSnapshot: async s => { assert.deepEqual(s, scope); return snapshot; },
    ownsScope: async s => s.epoch === 1,
    lockDocument: async (_, execute) => execute(),
    docs: {
      async read(target) { assert.equal(target, id); return doc(); },
      async write(target) { assert.equal(target, id); changed = true; calls.push('write'); },
    },
    api: {
      scopes: async () => ({ ok: true, assignments: [registry] }),
      async sync(input) {
        assert.deepEqual(input, { courseId, courseWorkId, snapshotComplete: true, submissions });
        calls.push('sync');
        return { pending: changed ? [] : [{ documentId: id, classroomSubmissionId: '300', assignmentCode, classCode }] };
      },
      async plan(input) {
        const startIndex = wrongRange ? 22 : 23;
        return { documentId: id, revisionId: input.document.revisionId, url: proofUrl,
          requests: changed ? [] : [{ updateTextStyle: {
            range: { tabId: 't.0', startIndex, endIndex: startIndex + anchor.length },
            fields: 'link,foregroundColor,underline',
            textStyle: { link: { url: proofUrl }, foregroundColor: {}, underline: false },
          } }] };
      },
      async verify() { assert.equal(changed, true); return { documentId: id, verified: true, status: 'linked' }; },
      async register(input) { assert.equal(input.classroomState, 'DELETED'); calls.push('close'); return { registered: true, status: 'closed' }; },
    },
  });
  const context = { async assertOwnership() {} };
  await assert.rejects(service.event({ ...event, student_id: '401' }, assignmentCode, doc(), context),
    { code: 'SPEAKING_EVENT_NOT_IN_CLASSROOM' });
  await assert.rejects(service.event(event, assignmentCode, doc(), context), { code: 'SPEAKING_PLAN_RANGE_MISMATCH' });
  wrongRange = false;
  assert.equal((await service.event(event, assignmentCode, doc(), context)).status, 'verified');
  assert.equal((await service.event(event, assignmentCode, doc(), context)).status, 'verified');
  assert.equal(calls.filter(x => x === 'write').length, 1);
  await assert.rejects(service.reconcile(scope, { ...snapshot, status: 'review' }, 1), { code: 'SPEAKING_SNAPSHOT_INCOMPLETE' });
  assert.equal((await service.reconcile(scope, { ...snapshot, classroomState: 'DRAFT', status: 'not_published' }, 1)).status, 'skipped');
  assert.equal((await service.reconcile(scope, { ...snapshot, classroomState: 'DELETED', status: 'not_published' }, 1)).status, 'closed');
  assert.equal(calls.filter(x => x === 'close').length, 1);
});

test('không chọn bừa registry trùng hoặc timestamp thiếu múi giờ', () => {
  assert.throws(() => parseK67SpeakingScopes({ ok: true, assignments: [registry, registry] }),
    { code: 'SPEAKING_ASSIGNMENT_SCOPE_DUPLICATE' });
  assert.throws(() => parseK67SpeakingScopes({ ok: true, assignments: [{ ...registry, opened_at: '2026-11-19T06:00:00' }] }),
    { code: 'SPEAKING_ASSIGNMENT_SCOPE_INVALID' });
});

test('registry và luồng Speaking giữ nguyên hai mã ôn tập clone đã phát', async () => {
  for (const code of ['67-speaking-on_tap_lam_ro_diem_giua-clone', '67-speaking-freestyle_on_tap-clone']) {
    const apiRow = { ...registry, assignment_code: code };
    const [scanned] = parseK67SpeakingScopes({ ok: true, assignments: [apiRow] });
    const document = { documentId: id, revisionId: 'r1', body: { content: [{ paragraph: { elements: [{ textRun: { content: code } }] } }] } };
    const url = new URL(proofUrl);
    url.searchParams.set('assignmentCode', code);
    const service = createK67SpeakingCta({
      getSnapshot: async value => { assert.equal(value.assignmentCode, code); return { ...snapshot, assignmentCode: code }; },
      docs: { async write() { assert.fail('Link đã có, không ghi lại'); } },
      api: {
        async scopes() { return { ok: true, assignments: [apiRow] }; },
        async sync() { return { pending: [] }; },
        async plan() { return { documentId: id, revisionId: 'r1', url: url.href, requests: [] }; },
        async verify() { return { documentId: id, verified: true, status: 'linked' }; },
      },
    });
    assert.equal(scanned.assignmentCode, code);
    assert.equal((await service.event(event, code, document, { async assertOwnership() {} })).entryUrl, url.href);
  }
});
