import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessSharedCta, createClassroomCtaDiscovery } from '../src/reading-listening67/classroom-cta-discovery.js';

const base = 'courses/100/courseWork';
const doc = 'document_123456789012345';
const timestamp = '2026-11-19T02:15:00Z';
const work = { id: '200', courseId: '100', state: 'PUBLISHED', updateTime: timestamp };
const speaking = [{ courseId: '100', courseWorkId: '200', assignmentCode: '67-speaking-paraphrase', deliveryMode: 'docs_cta' }];
const course = { courseId: '100', classCode: 'IC-TEST', shared: true, speaking };
const row = (files, extra = {}) => ({
  id: 'submission', userId: 'owner', courseId: '100', courseWorkId: '200',
  assignmentSubmission: { attachments: files.map(driveFile => ({ driveFile })) },
  ...extra,
});
const googleDoc = { id: doc, alternateLink: 'https://docs.google.com/document/d/' + doc + '/edit' };

test('reuses pages for both scanners and notices a late copy without a Coursework update', async () => {
  const requests = [];
  let files = [];
  const scan = createClassroomCtaDiscovery({
    get: async (path, params) => {
      requests.push(path);
      if (path === base) return { courseWork: [work] };
      assert.equal(path, base + '/200/studentSubmissions');
      assert.match(params.fields, /driveFile\(id,alternateLink\)/);
      return { studentSubmissions: [row(files)] };
    },
  });
  const before = await scan(course);
  assert.equal(before.sources.length, 0);
  assert.equal(before.speaking[0].submissions[0].documentId, null);
  files = [googleDoc];
  const after = await scan(course);
  assert.equal(after.sources[0].documentId, doc);
  assert.equal(after.sources[0].classroom.studentId, 'owner');
  assert.equal(after.sources[0].classroom.sourceVersion, timestamp);
  assert.equal(after.speaking[0].submissions[0].documentId, doc);
  assert.deepEqual(requests, [base, base + '/200/studentSubmissions', base, base + '/200/studentSubmissions']);
});

test('keeps shared attachments when the Speaking snapshot requires review', async () => {
  const scan = createClassroomCtaDiscovery({ get: async path => path === base
    ? { courseWork: [work] }
    : { studentSubmissions: [row([googleDoc, { id: 'not-a-doc' }])] } });
  const result = await scan(course);
  assert.equal(result.sources.length, 1);
  assert.equal(result.speaking[0].reason, 'CLASSROOM_COPY_AMBIGUOUS');
  assert.equal(result.speaking[0].submissions, undefined);
});

test('does not infer closed Speaking work from missing or inaccessible Coursework', async () => {
  const calls = [];
  const scan = createClassroomCtaDiscovery({
    get: async path => {
      calls.push(path);
      if (path === base) return {};
      throw Object.assign(new Error('not accessible'), { code: 'CLASSROOM_FORBIDDEN' });
    },
  });
  await assert.rejects(scan(course), { code: 'CLASSROOM_FORBIDDEN' });
  assert.deepEqual(calls, [base, base + '/200']);
});

test('rejects wrong scope, mismatched attachment and repeated page token', async () => {
  for (const [candidate, nextPageToken, code] of [
    [row([googleDoc], { courseWorkId: '201' }), undefined, 'CLASSROOM_SUBMISSION_IDENTITY'],
    [row([{ ...googleDoc, id: 'wrong' }]), undefined, 'CLASSROOM_ATTACHMENT_IDENTITY'],
    [row([googleDoc]), 'repeat', 'CLASSROOM_PAGE_TOKEN_INVALID'],
  ]) {
    const scan = createClassroomCtaDiscovery({ get: async path => path === base
      ? { courseWork: [work] }
      : { studentSubmissions: [candidate], nextPageToken } });
    await assert.rejects(scan(course), { code });
  }
});

test('preserves Speaking direct and explicit unpublished lifecycle decisions', async () => {
  const heard = [];
  const scan = createClassroomCtaDiscovery({
    get: async path => {
      heard.push(path);
      return path === base + '/200' ? work : { ...work, id: '201', state: 'DELETED' };
    },
  });
  const result = await scan({ ...course, shared: false, speaking: [
    { ...speaking[0], deliveryMode: 'direct' }, { ...speaking[0], courseWorkId: '201' },
  ] });
  assert.deepEqual(heard, [base + '/200', base + '/201']);
  assert.deepEqual(result.speaking.map(item => item.status), ['direct', 'not_published']);
});

test('predicts dispatch without reviving an old ready source or taking a lease', () => {
  const source = { classroom: { studentId: 'owner', sourceVersion: timestamp } };
  const prior = { student_id: 'owner', source_version: timestamp, cta_state: 'ready', cta_pipeline_version: 2 };
  const now = Date.parse(timestamp);
  assert.equal(assessSharedCta(source, null, now), 'new');
  assert.equal(assessSharedCta(source, prior, now), 'no_change');
  assert.equal(assessSharedCta(source, { ...prior, cta_pipeline_version: 1 }, now), 'historical_baseline');
  assert.equal(assessSharedCta(source, { ...prior, student_id: 'other' }, now), 'owner_conflict');
  const pending = { ...prior, cta_state: 'pending', cta_lease_until: new Date(now + 30_000) };
  assert.equal(assessSharedCta(source, pending, now), 'publish_existing_lease');
  assert.equal(assessSharedCta(source, { ...pending, cta_enqueued_at: new Date(now) }, now), 'in_flight');
  const retry = { ...prior, cta_state: 'error', cta_attempts: 7, cta_retry_at: new Date(now + 1000) };
  assert.equal(assessSharedCta(source, retry, now), 'backoff');
  assert.equal(assessSharedCta(source, retry, now + 1000), 'retry_due');
  assert.equal(assessSharedCta(source, { ...retry, cta_attempts: 8 }, now + 1000), 'retry_exhausted');
});
