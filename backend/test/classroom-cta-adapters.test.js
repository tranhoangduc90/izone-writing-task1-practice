import assert from 'node:assert/strict';
import test from 'node:test';
import { buildK67CtaEvent, createK67ProductAdapters, findK67ListeningHomeworkCode,
  findK67ReadingHomeworkCode, findK67SpeakingCode } from '../src/reading-listening67/classroom-cta-adapters.js';

const documentId = 'fixture_document_123456789012345';
const lesson2Speaking = '67-speaking-paraphrase';
const lesson2Listening = '67-listening-scandinavian-studies';
const listeningAnchor = 'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP LISTENING';
const readingOld = '67-reading-materials-beyond-concrete-matching-information-nen-cap-1';

function doc(...paragraphs) {
  const content = paragraphs.map(text => ({ paragraph: { elements: [{ textRun: { content: text + '\n' } }] } }));
  const tableCells = [{ content }];
  const nested = [{ table: { tableRows: [{ tableCells }] } }];
  return { documentId, revisionId: 'fixture-revision', tabs: [{ documentTab: { body: { content: [] } }, childTabs: [
    { documentTab: { body: { content: nested } } },
  ] }] };
}

test('nhận mã theo vị trí và giữ đúng ngoại lệ Reading cũ', () => {
  const lesson2 = doc(lesson2Speaking, listeningAnchor, lesson2Listening);
  assert.equal(findK67SpeakingCode(lesson2), lesson2Speaking);
  assert.equal(findK67ListeningHomeworkCode(lesson2), lesson2Listening);
  assert.equal(findK67ListeningHomeworkCode(doc(lesson2Listening)), null);
  assert.equal(findK67ReadingHomeworkCode(lesson2, '111'), null);
  assert.equal(findK67ReadingHomeworkCode(doc(readingOld), '826336470852'), readingOld);
  assert.equal(findK67ReadingHomeworkCode(doc(readingOld), '111'), null);
  assert.throws(() => findK67ReadingHomeworkCode(doc(readingOld + ' mixed'), '826336470852'),
    { code: 'READING67_CTA_CODE_AMBIGUOUS' });
  assert.throws(() => findK67SpeakingCode(doc(lesson2Speaking, '67-speaking-other')),
    { code: 'SPEAKING_SOURCE_CODE_AMBIGUOUS' });
  assert.throws(() => findK67ListeningHomeworkCode(doc(listeningAnchor, lesson2Listening, lesson2Listening)),
    { code: 'LISTENING_HW_CODE_AMBIGUOUS' });
});

test('mã Speaking clone giữ nguyên hậu tố và chỉ ghép các phần chữ trong cùng đoạn', () => {
  const clone = '67-speaking-on_tap_lam_ro_diem_giua-clone';
  const paragraph = (...parts) => ({ paragraph: { elements: parts.map(content => ({ textRun: { content } })) } });
  const body = (...content) => ({ body: { content } });
  assert.equal(findK67SpeakingCode(body(paragraph(clone.slice(0, -6), '-clone'))), clone);
  assert.equal(findK67SpeakingCode(body(paragraph(lesson2Speaking), paragraph('x'))), lesson2Speaking);
  assert.equal(findK67SpeakingCode(body(paragraph('x'), paragraph(clone))), clone);
  assert.equal(findK67SpeakingCode(body(paragraph('x-' + clone))), null);
  assert.throws(() => findK67SpeakingCode(doc(clone, '67-speaking-on_tap_lam_ro_diem_giua')),
    { code: 'SPEAKING_SOURCE_CODE_AMBIGUOUS' });
});

test('adapter chỉ xác nhận biên nhận đúng mã, đích và quyền sở hữu', async () => {
  const context = { source: { documentId, classroom: { courseId: '100', courseworkId: '200',
    submissionId: '300', studentId: '400', classCode: 'QA67', homeworkTitle: 'Lesson 2' } },
  dispatchToken: 'f10c4710-446b-4cde-8197-2fbd002ec468',
  async assertOwnership() { assert.equal(owned, true); } };
  const event = buildK67CtaEvent(context);
  assert.equal(event.cta_dispatch_token, context.dispatchToken);
  assert.equal(event.cta_pipeline_version, 2);
  assert.equal(event.doc_id, documentId);
  assert.equal(event.student_id, '400');
  let owned = true;
  let reads = 0;
  let calls = 0;
  const absent = async () => ({ documentId, status: 'not_applicable' });
  const adapters = createK67ProductAdapters({
    async readDocument() { reads++; return doc(lesson2Speaking, listeningAnchor, lesson2Listening); },
    readingHomework: absent, readingPractice: absent, legacy: absent, listeningPractice: absent,
    async speaking(received, code) {
      calls++;
      assert.deepEqual(received, event);
      return { ok: true, documentId, assignmentCode: code, status: 'verified' };
    },
    async listeningHomework(received) {
      calls++;
      assert.deepEqual(received, event);
      return { ok: true, documentId, assignmentCode: 'wrong', status: 'verified' };
    },
  });
  assert.equal((await adapters.reading_homework(context)).status, 'not_applicable');
  assert.equal((await adapters.speaking(context)).status, 'verified');
  await assert.rejects(adapters.listening_homework(context), { code: 'LISTENING_HW_CTA_READBACK_REQUIRED' });
  assert.equal(reads, 3);
  assert.equal(calls, 2);
  owned = false;
  await assert.rejects(adapters.speaking(context));
  assert.equal(calls, 2);
});
