import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createClassroomCtaDiscovery } from '../src/reading-listening67/classroom-cta-discovery.js';
import {
  createClassroomCtaDocumentLock, createClassroomCtaProcessor, createClassroomCtaProducer,
} from '../src/reading-listening67/classroom-cta-pipeline.js';
import { createReadingListening67Store } from '../src/reading-listening67/store.js';
import { createK67NativeStore, releaseUnstartedK67CtaJobs } from '../src/reading-listening67/classroom-cta-native-store.js';
import { createK67WritingRegistry, createK67WritingSourceLane } from '../src/reading-listening67/classroom-cta-writing.js';

const courseId = '100';
const courseWorkId = '200';
const documentId = 'fixture_document_123456789012345';
const sourceVersion = '2026-11-19T06:00:00Z';
const scope = { courseId, courseWorkId, classCode: 'QA67', classroomName: 'CTA QA', shared: true, epoch: 3, speaking: [] };

async function harness(t, { failListening = false, loseConfirmation = false } = {}) {
  const database = process.env.K67_CTA_REPLAY_DB;
  let db, pool, applyMigration;
  if (database) {
    assert.equal(database, 'postgresql://lab@postgres:5432/lab');
    const { Pool } = await import('pg');
    pool = db = new Pool({ connectionString: database, max: 3 });
    applyMigration = sql => db.query(sql);
    t.after(async () => {
      try {
        await db.query('DROP SCHEMA IF EXISTS reading_listening67 CASCADE');
      } finally {
        await db.end();
      }
    });
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    db = new PGlite();
    const client = { query: (...args) => db.query(...args), release() {} };
    pool = { ...client, connect: async () => client };
    applyMigration = sql => db.exec(sql);
    t.after(() => db.close());
  }
  for (const file of [
    '2026-10-07-reading-listening67-v1.sql',
    '2026-10-07-reading-listening67-classroom-source.sql',
    '2026-10-07-reading-listening67-source-scan.sql',
    '2026-10-07-reading-listening67-cta-dispatch.sql',
    '2026-11-06-homework-cta-recovery.sql',
    '2026-11-19-k67-cta-native-runtime.sql',
    '2026-11-19-k67-cta-writing-source.sql',
  ]) {
    const sql = await readFile(new URL('../../docs/migrations/' + file, import.meta.url), 'utf8');
    await applyMigration(sql.replace(/^GRANT .*;$/gm, ''));
  }
  const store = createReadingListening67Store({ pool });
  const writes = [];
  const inbox = [];
  const events = [];
  let currentEpoch = scope.epoch;
  const ownsScope = async entry => entry.epoch === currentEpoch
    && entry.courseId === courseId && entry.classCode === scope.classCode;
  const discover = createClassroomCtaDiscovery({
    get: async path => {
      if (path === 'courses/100/courseWork/200') {
        return { id: courseWorkId, courseId, title: 'QA Lesson 2', state: 'PUBLISHED', updateTime: sourceVersion };
      }
      assert.equal(path, 'courses/100/courseWork/200/studentSubmissions');
      return { studentSubmissions: [{
        courseId, courseWorkId, userId: '300', id: '400',
        assignmentSubmission: { attachments: [{ driveFile: {
          id: documentId, alternateLink: 'https://docs.google.com/document/d/' + documentId + '/edit',
        } }] },
      }] };
    },
  });
  function verified(product) {
    return async ({ source, assertOwnership }) => {
      await assertOwnership();
      assert.equal(source.classroom.studentId, '300');
      if (product === 'listening_homework' && failListening) {
        failListening = false;
        throw Object.assign(new Error('fixture retry'), { code: 'DOCS_READ_FAILED' });
      }
      writes.push(product);
      return { documentId, status: 'verified' };
    };
  }
  const absent = async () => ({ documentId, status: 'not_applicable' });
  const log = entry => events.push(entry);
  const produce = createClassroomCtaProducer({
    store, discover, ownsScope, log,
    async publish(job) {
      inbox.push(job);
      if (loseConfirmation) {
        loseConfirmation = false;
        return { confirmed: false };
      }
      return { confirmed: true, dispatchToken: job.dispatchToken };
    },
  });
  const consume = createClassroomCtaProcessor({
    store, ownsScope, log, lockDocument: createClassroomCtaDocumentLock({ pool }),
    adapters: {
      speaking: verified('speaking'), listening_homework: verified('listening_homework'),
      reading_homework: absent, reading_practice: absent, listening_practice: absent, legacy: absent,
    },
    async verifyProof(_, proof) {
      assert.equal(proof.length, 6);
      return [];
    },
  });
  return { db, store, native: createK67NativeStore({ pool }), produce,
    process: consume, inbox, writes, events, changeOwner: () => ++currentEpoch };
}

test('ca Lesson 2 phát qua lease, chốt đủ biên nhận và chạy lại không ghi', async t => {
  const h = await harness(t, { loseConfirmation: true });
  await assert.rejects(h.produce(scope), { code: 'CTA_PUBLISH_UNCONFIRMED' });
  const run = await h.produce(scope);
  assert.equal(run.published, 1);
  assert.equal(h.inbox.length, 2);
  const [unconfirmed, confirmed] = h.inbox;
  assert.equal(unconfirmed.dispatchToken, confirmed.dispatchToken);
  assert.equal((await h.process(confirmed)).state, 'ready');
  assert.equal((await h.process(unconfirmed)).state, 'skipped');
  assert.equal((await h.produce(scope)).published, 0);
  assert.deepEqual(h.writes, ['speaking', 'listening_homework']);
  const { rows } = await h.db.query('SELECT cta_state, cta_proof FROM reading_listening67.source_document');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].cta_state, 'ready');
  assert.equal(rows[0].cta_proof.length, 6);
  assert.equal(h.events.some(entry => JSON.stringify(entry).includes(documentId)), false);
});

test('ca hết quyền sở hữu bị chặn, retry cùng phiên bản chỉ thực hiện phần còn thiếu', async t => {
  const h = await harness(t, { failListening: true });
  await h.produce(scope);
  const [old] = h.inbox;
  const epoch = h.changeOwner();
  await assert.rejects(h.process(old), { code: 'CTA_SCOPE_NOT_OWNED' });
  await assert.rejects(h.process({ ...old, epoch, source: {
    ...old.source, classroom: { ...old.source.classroom, studentId: 'wrong' },
  } }), { code: 'SOURCE_DISPATCH_IDENTITY_MISMATCH' });
  const result = await h.process({ ...old, epoch });
  assert.equal(result.state, 'error');
  assert.equal(result.errorCode, 'DOCS_READ_FAILED');
  assert.deepEqual(h.writes, ['speaking']);
  await h.db.query("UPDATE reading_listening67.source_document SET cta_retry_at=now()-interval '1 minute'");
  const run = await h.produce({ ...scope, epoch });
  assert.equal(run.published, 1);
  assert.notEqual(h.inbox[1].dispatchToken, old.dispatchToken);
  assert.equal((await h.process(h.inbox[1])).state, 'ready');
  assert.deepEqual(h.writes, ['speaking', 'listening_homework']);
  assert.equal(h.events.some(entry => entry.product === 'speaking' && entry.resumed === true), true);
});

test('hàng bền giữ nguyên token khi restart, chặn ACK cũ và chỉ chạy một slot', async t => {
  const h = await harness(t);
  const { native } = h;
  await h.db.query("INSERT INTO reading_listening67.cta_native_owner(course_id,class_code,owner,epoch) VALUES('100','QA67','backend',3)");
  assert.equal(await native.ownsScope(scope), true);
  assert.equal(await native.ownsScope({ ...scope, epoch: 2 }), false);
  await h.produce(scope);
  const [event] = h.inbox;
  assert.deepEqual(await native.checkedUnchanged([event.source]), []);
  assert.equal((await native.publish({ ...event, epoch: 2 })).confirmed, false);
  assert.equal((await native.publish(event)).confirmed, true);
  assert.equal((await native.publish(event)).dispatchToken, event.dispatchToken);
  const first = await native.claim();
  assert.equal(first.dispatchToken, event.dispatchToken);
  assert.equal(await native.ownsJob(first), true);
  assert.equal(await native.claim(), null);
  await h.db.query("UPDATE reading_listening67.cta_native_job SET lease_until=now()-interval '1 minute'");
  const next = await native.claim();
  assert.equal(next.executionId, first.executionId);
  assert.notEqual(next.leaseToken, first.leaseToken);
  await assert.rejects(native.settle(first, { state: 'ready' }), { code: 'CTA_NATIVE_RECEIPT_UNSAVED' });
  const result = await h.process(next);
  assert.equal(result.state, 'ready');
  await native.settle(next, result);
  assert.equal(await native.claim(), null);
  assert.deepEqual(await native.checkedUnchanged([event.source]), [{
    documentId, courseId, courseworkId: courseWorkId, submissionId: '400', saved: true, ctaNeeded: false,
  }]);
  assert.deepEqual(h.writes, ['speaking', 'listening_homework']);
  const slot = new Date('2026-11-19T07:45:00Z');
  assert.equal((await native.withSlot(slot, async () => ({ status: 'done' }))).status, 'done');
  assert.equal((await native.withSlot(slot, async () => assert.fail('should run once'))).status, 'already_run');
});

test('đổi sang draining chặn native, tuyến cũ đọc lại nguồn đã xác minh và tiếp tục nguồn chờ', async t => {
  const h = await harness(t);
  const { native } = h;
  await h.db.query("INSERT INTO reading_listening67.cta_native_owner(course_id,class_code,owner,epoch) VALUES('100','QA67','backend',3)");
  await h.produce(scope);
  const [event] = h.inbox;
  assert.equal((await native.publish(event)).confirmed, true);
  const confirmed = await native.claim();
  const result = await h.process(confirmed);
  await native.settle(confirmed, result);
  const next = {
    documentId: 'second_fixture_document_123456',
    classroom: { ...event.source.classroom, submissionId: '401', sourceEventId: 'fixture-second-source' },
  };
  const pending = await h.store.source(next);
  assert.equal(pending.ctaNeeded, true);
  const queuedOldEpoch = { ...event, source: next, dispatchToken: pending.dispatchToken };
  assert.equal((await native.publish(queuedOldEpoch)).confirmed, true);
  await h.store.sourceCtaEnqueuedBatch({ sources: [{ documentId: next.documentId, courseId,
    courseworkId: courseWorkId, submissionId: next.classroom.submissionId, dispatchToken: pending.dispatchToken }] });
  assert.equal((await h.store.source(next)).ctaNeeded, false);
  assert.equal((await releaseUnstartedK67CtaJobs(h.db, { ...scope, drainingEpoch: 3 })).released, 0);
  await h.db.query("UPDATE reading_listening67.cta_native_owner SET owner='draining',epoch=4 WHERE course_id='100'");
  assert.equal(await native.ownsScope(scope), false);
  assert.equal(await native.claim(), null);
  assert.equal((await native.publish(queuedOldEpoch)).confirmed, false);
  assert.equal((await releaseUnstartedK67CtaJobs(h.db, { ...scope, drainingEpoch: 4 })).released, 1);
  await h.db.query("UPDATE reading_listening67.cta_native_owner SET owner='n8n',epoch=5 WHERE course_id='100'");
  assert.equal((await h.store.source(event.source)).ctaNeeded, false);
  assert.equal((await h.store.source(next)).dispatchToken, pending.dispatchToken);
  assert.deepEqual(h.writes, ['speaking', 'listening_homework']);
});

test('Writing dùng nguồn chung đúng registry, giữ trạng thái chờ và chốt biên nhận riêng', async t => {
  const h = await harness(t);
  await h.db.query("INSERT INTO reading_listening67.cta_native_owner(course_id,class_code,owner,epoch) VALUES('100','QA67','backend',3)");
  await h.db.query('CREATE TEMP TABLE assignments(id text PRIMARY KEY,definition jsonb NOT NULL)');
  const assignment = { authorityClassId: '99', contentVersion: 2,
    classroom: { courseId, courseWorkId, ctaCode: '67-writing-lesson5' } };
  await h.db.query('INSERT INTO assignments VALUES ($1,$2)', ['lesson5', JSON.stringify(assignment)]);
  const readRegistry = createK67WritingRegistry({ pool: h.db });
  await h.produce(scope);
  const [event] = h.inbox;
  const sent = [];
  const writing = createK67WritingSourceLane({ pool: h.db, readRegistry, ownsScope: h.native.ownsScope,
    async submit(input) {
      sent.push(input);
      if (sent.length === 1) throw Object.assign(Error('fixture waiting'), { code: 'CTA_PENDING' });
      return { documentId, status: 'verified', ok: true };
    },
  });
  assert.equal((await writing.discover({ ...scope, erpClassId: '100' }, [event.source])).queued, 0);
  assert.equal((await writing.discover({ ...scope, erpClassId: '99' }, [event.source])).queued, 1);
  assert.equal((await writing.discover({ ...scope, erpClassId: '99' }, [event.source])).queued, 0);
  assert.equal((await writing.workOnce()).status, 'pending');
  assert.equal((await writing.workOnce()).status, 'idle');
  await h.db.query("UPDATE reading_listening67.cta_native_writing_source SET eligible_at=now()-interval '1 minute'");
  assert.equal((await writing.workOnce()).status, 'verified');
  assert.equal((await writing.workOnce()).status, 'idle');
  assert.deepEqual(sent[0], sent[1]);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['class_name', 'classroom_course_id', 'coursework_id', 'doc_id', 'student_id', 'submission_id']);
});
