import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createClassroomCtaServer } from '../src/reading-listening67/classroom-cta-service.js';

test('serves both scan snapshots to the authenticated dispatch bridge and rejects other scopes', async t => {
  const token = 'qa-test-token-32-characters-long';
  const courseId = '12';
  const courseWorkId = '34';
  const documentId = 'abcdefghijklmnopqrstuvwxyz';
  const calls = [];
  const server = createClassroomCtaServer({
    token,
    classes: [{ courseId, classCode: 'IC1' }],
    get: async path => {
      calls.push(path);
      if (path.endsWith('/studentSubmissions')) return { studentSubmissions: [{
        id: 'submission', userId: 'owner', courseId, courseWorkId,
        assignmentSubmission: { attachments: [{ driveFile: {
          id: documentId, alternateLink: 'https://docs.google.com/document/d/' + documentId + '/edit',
        } }] },
      }] };
      return { courseWork: [{ id: courseWorkId, courseId, state: 'PUBLISHED', title: 'Lesson 2',
        updateTime: '2026-11-19T03:00:00Z' }] };
    },
  });
  t.after(() => new Promise(resolve => server.close(resolve)));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = 'http://127.0.0.1:' + server.address().port + '/scan';
  const scan = (payload, auth = token) => fetch(url, {
    method: 'POST', headers: { authorization: 'Bearer ' + auth, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const scope = { courseId, classCode: 'IC1', classroomName: 'QA scope', speaking: [{
    courseId, courseWorkId, classCode: 'IC1', assignmentCode: '67-speaking-paraphrase', deliveryMode: 'docs_cta',
  }] };
  assert.equal((await scan(scope, 'bad')).status, 401);
  assert.equal((await scan({ ...scope, courseId: '99' })).status, 403);
  assert.equal((await scan({ ...scope, speaking: [{ ...scope.speaking[0], classCode: 'IC2' }] })).status, 403);
  assert.equal(calls.length, 0);
  const response = await scan(scope);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.sources[0].documentId, documentId);
  assert.deepEqual(receipt.speaking[0].submissions, [{ id: 'submission', userId: 'owner', documentId }]);
  assert.equal(receipt.counts.submissionPages, 1);
  assert.equal(calls.length, 2);
});
