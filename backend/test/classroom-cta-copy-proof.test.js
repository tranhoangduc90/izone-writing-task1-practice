import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyClassroomCopy } from '../src/reading-listening67/cta-confirmation-client.js';

const event = { classroom_course_id: '100', coursework_id: '200', submission_id: 'sub-300',
  student_id: '123456789012345678901', doc_id: 'fixture_student_document', class_name: 'IC9999' };
const speakingCode = '67-speaking-paraphrase';
const path = '/v1/courses/100/courseWork/200';
const list = path + '/studentSubmissions';
const single = list + '/sub-300';
const assignment = { id: '200', courseId: '100', state: 'PUBLISHED', assigneeMode: 'INDIVIDUAL_STUDENTS',
  individualStudentsOptions: { studentIds: [event.student_id] },
  materials: [{ driveFile: { shareMode: 'STUDENT_COPY', driveFile: { id: 'fixture_teacher_template' } } }] };
const copy = { id: event.submission_id, courseId: '100', courseWorkId: '200', userId: event.student_id,
  assignmentSubmission: { attachments: [{ driveFile: { id: event.doc_id } }] } };

function fixture(page, work = assignment) {
  const requests = [];
  const verify = verifyClassroomCopy({ getAccessToken: async () => ({ token: 'fixture' }) }, {
    fetcher: async url => {
      const parsed = new URL(url);
      requests.push(parsed.pathname);
      if (parsed.pathname === path) return Response.json(work);
      if (parsed.pathname === single) return Response.json(copy);
      assert.equal(parsed.pathname, list);
      assert.equal(parsed.searchParams.get('pageSize'), '100');
      return Response.json(page);
    },
  });
  return { verify, requests };
}

test('a complete Speaking roster verifies the exact copy in two Classroom requests', async () => {
  const { verify, requests } = fixture({ studentSubmissions: [copy] });
  assert.deepEqual(await verify(event, { speakingCode }), {
    courseId: '100', courseWorkId: '200', assignmentCode: speakingCode, classroomState: 'PUBLISHED', status: 'snapshot',
    submissions: [{ id: event.submission_id, userId: event.student_id, documentId: event.doc_id }],
  });
  assert.deepEqual(requests, [path, list]);
});

test('a claimed but wrong roster owner or unassigned student never establishes copy proof', async () => {
  const wrongOwner = fixture({ studentSubmissions: [{ ...copy, userId: 'other' }] });
  await assert.rejects(wrongOwner.verify(event, { speakingCode }), { code: 'CLASSROOM_COPY_NOT_VERIFIED' });
  assert.deepEqual(wrongOwner.requests, [path, list]);
  const unassigned = fixture({ studentSubmissions: [copy] }, { ...assignment, individualStudentsOptions: { studentIds: [] } });
  await assert.rejects(unassigned.verify(event, { speakingCode }), { code: 'CLASSROOM_COPY_NOT_VERIFIED' });
});

test('partial roster falls back to exact-copy proof without handing out a shared roster', async () => {
  const partial = fixture({ nextPageToken: 'next', studentSubmissions: [copy] });
  assert.equal(await partial.verify(event, { speakingCode }), undefined);
  assert.deepEqual(partial.requests, [path, list, single]);
  const nonSpeaking = fixture(null);
  assert.equal(await nonSpeaking.verify(event), undefined);
  assert.deepEqual(nonSpeaking.requests, [path, single]);
});
