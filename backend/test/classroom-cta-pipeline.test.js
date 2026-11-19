import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { createClassroomCtaDiscovery } from '../src/reading-listening67/classroom-cta-discovery.js';
import {
  createClassroomCtaDocumentLock, createClassroomCtaProcessor, createClassroomCtaProducer, createK67NativeScanLock,
} from '../src/reading-listening67/classroom-cta-pipeline.js';
import { createReadingListening67Store } from '../src/reading-listening67/store.js';
import { createK67NativeStore, releaseUnstartedK67CtaJobs } from '../src/reading-listening67/classroom-cta-native-store.js';
import { createK67CtaStack } from '../src/reading-listening67/classroom-cta-stack.js';
import { createK67CtaHttp } from '../src/reading-listening67/classroom-cta-http.js';
import { createK67WritingRegistry, createK67WritingSourceLane } from '../src/reading-listening67/classroom-cta-writing.js';

const courseId = '100';
const courseWorkId = '200';
const documentId = 'fixture_document_123456789012345';
const sourceVersion = '2026-11-19T06:00:00Z';
const scope = { courseId, courseWorkId, classCode: 'QA67', classroomName: 'CTA QA', shared: true, epoch: 3, speaking: [] };
const enrollmentSql = () => readFile(new URL('../../docs/migrations/2026-11-20-k67-cta-scope-enrollment.sql', import.meta.url), 'utf8');

test('quyền nhận lớp không sửa owner cũ và công tắc khóa trước khi quay về n8n',
  { skip: !process.env.K67_CTA_REPLAY_DB }, async t => {
    const { db, applyMigration, native } = await harness(t);
    await db.query(`CREATE ROLE reading_listening67_api NOLOGIN;
      CREATE ROLE cta_enrollment_other NOLOGIN;
      GRANT USAGE ON SCHEMA reading_listening67 TO reading_listening67_api, cta_enrollment_other;
      GRANT SELECT ON reading_listening67.cta_native_owner TO reading_listening67_api;
      INSERT INTO reading_listening67.cta_native_owner(course_id,class_code,owner,epoch)
        VALUES ('900','IC8000','backend',8)`);
    await applyMigration(await enrollmentSql());
    const evidence = { courseId: '100', classCode: 'IC2353', erpClassId: '10', observedAt: new Date().toISOString() };
    const asApplication = async (role, action) => {
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        switch (role) {
          case 'other': await client.query('SET LOCAL ROLE cta_enrollment_other'); break;
          case 'application': await client.query('SET LOCAL ROLE reading_listening67_api'); break;
          default: assert.fail('Unexpected fixture role');
        }
        const result = await action(client);
        await client.query('COMMIT');
        return result;
      } finally {
        await client.query('ROLLBACK');
        client.release();
      }
    };
    const adopt = input => asApplication('application', client => createK67NativeStore({ pool: client }).enrollScope(input));
    assert.equal((await adopt(evidence)).status, 'disabled');
    await db.query('UPDATE reading_listening67.cta_native_enrollment_policy SET enabled=true');
    assert.equal((await adopt({ ...evidence, observedAt: '2026-01-01T00:00:00Z' })).status, 'invalid_evidence');
    await assert.rejects(asApplication('other', client => createK67NativeStore({ pool: client }).enrollScope(evidence)), { code: '42501' });
    await assert.rejects(asApplication('application', client =>
      client.query("UPDATE reading_listening67.cta_native_owner SET epoch=10 WHERE course_id='900'")), { code: '42501' });
    const receipts = await Promise.all([adopt(evidence), adopt(evidence)]);
    assert.deepEqual(receipts.map(row => row.status).sort(), ['enrolled', 'existing']);
    assert.ok(receipts.every(row => row.epoch === 1));
    assert.equal((await adopt({ ...evidence, courseId: '101' })).status, 'identity_conflict');
    assert.equal((await adopt({ ...evidence, courseId: '102', classCode: 'IC2000' })).status, 'identity_conflict');
    assert.equal((await adopt({ ...evidence, courseId: '900' })).status, 'identity_conflict');
    await db.query("UPDATE reading_listening67.cta_native_owner SET owner='draining',epoch=2 WHERE course_id='100'");
    assert.equal((await adopt(evidence)).status, 'draining');
    assert.equal((await adopt({ ...evidence, courseId: '102', classCode: 'IC2000', erpClassId: '21' })).status, 'legacy_present');
    await db.query("UPDATE reading_listening67.cta_native_owner SET owner='n8n',epoch=3 WHERE course_id='100'");
    assert.equal((await adopt(evidence)).status, 'n8n');
    await db.query('UPDATE reading_listening67.cta_native_enrollment_policy SET enabled=false');
    assert.equal((await adopt({ ...evidence, courseId: '102', classCode: 'IC2000', erpClassId: '21' })).status, 'disabled');
    assert.deepEqual((await db.query('SELECT course_id,owner,epoch FROM reading_listening67.cta_native_owner ORDER BY course_id')).rows,
      [{ course_id: '100', owner: 'n8n', epoch: 3 }, { course_id: '900', owner: 'backend', epoch: 8 }]);
  });

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
    const client = {
      async query(...args) {
        const result = await db.query(...args);
        // Mirror the pg Pool contract for statements that return no rows.
        return { ...result, rowCount: result.affectedRows ?? result.rows.length };
      },
      release() {},
    };
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
  return { db, pool, store, applyMigration, native: createK67NativeStore({ pool }), produce,
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

for (const autoEnroll of [false, true]) test(autoEnroll
  ? 'lớp mới tự vào lịch và nhận hai CTA Lesson 2, một chủ ghi, chạy lại giữ nguyên Docs'
  : 'Lesson 2 qua HTTP và stack CTA, kiểm quyền rồi phát lại khi n8n còn giữ khóa quét cũ', async t => {
  const { db, pool, store, applyMigration } = await harness(t);
  const heldLegacyScan = await store.scanStart({ executionId: 'fixture-legacy-scan' });
  assert.equal(heldLegacyScan.acquired, true);
  const classCode = 'IC2353';
  const googleUserId = '123456789012345678901';
  await db.query(`INSERT INTO reading_listening67.cta_native_owner(course_id,class_code,owner,epoch)
    VALUES ($1,$2,'backend',3)`, autoEnroll ? ['900', 'IC8000'] : [courseId, classCode]);
  if (autoEnroll) {
    await applyMigration((await enrollmentSql()).replace(/^GRANT .*;$/gm, ''));
    await db.query('UPDATE reading_listening67.cta_native_enrollment_policy SET enabled=true');
  }
  const speakingCode = '67-speaking-paraphrase', listeningCode = '67-listening-scandinavian-studies';
  const tabId = 'lesson-2';
  const anchors = ['NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP SPEAKING', 'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP LISTENING'];
  const links = ['speaking-homework', 'listening-homework'].map((page, i) =>
    `https://tranhoangduc90.github.io/izone-ai-team-pages/${page}/?documentId=${documentId}&class=${classCode}&assignmentCode=${[speakingCode, listeningCode][i]}`);
  const paragraphs = [...anchors, speakingCode, listeningCode].map((content, index) => ({
    paragraph: { elements: [{ startIndex: 1 + 100 * index, endIndex: 1 + 100 * index + content.length,
      textRun: { content } }] },
  }));
  const document = { documentId, revisionId: 'r0', tabs: [{ tabProperties: { tabId },
    documentTab: { body: { content: paragraphs } } }] };
  const writes = [], reads = [], checks = [], events = [], roster = new Map();
  function commitLink(index) {
    const run = paragraphs[index].paragraph.elements[0].textRun;
    assert.equal(run.textStyle, undefined);
    run.textStyle = { link: { url: links[index] } };
    writes.push(index);
    document.revisionId = 'r' + writes.length;
  }
  const submission = { courseId, courseWorkId, id: '400', userId: googleUserId, assignmentSubmission: {
    attachments: [{ driveFile: { id: documentId, alternateLink: `https://docs.google.com/document/d/${documentId}/edit` } }],
  } };
  const coursework = { id: courseWorkId, courseId, title: 'Homework Lesson 2', state: 'PUBLISHED', updateTime: sourceVersion };
  const absent = async event => ({ documentId: event.doc_id, status: 'not_applicable' });
  const stack = createK67CtaStack({ pool, autoEnroll,
    log: event => events.push(event),
    async getPortal() {
      const snapshot = { schemaVersion: 1, source: 'portal_erp_live', observedAt: new Date().toISOString(), count: 1,
        classes: [{ erpClassId: '10', classCode, courseId: '5', courseShortName: '67', status: 'on_going',
          classDeletedAt: null, courseDeletedAt: null }] };
      return { status: 'completed', data: { cols: [{ name: 'payload' }], rows: [[snapshot]] } };
    },
    async getMappings(classes) {
      assert.deepEqual(classes, [{ erpClassId: '10', classCode }]);
      return [{ erpClassId: '10', courseId, status: 'approved', approvedCourseReferences: 1 }];
    },
    async classroomGet(path) {
      reads.push(path);
      if (path === 'courses/100') return { id: courseId, name: 'CTA QA', courseState: 'ACTIVE' };
      if (path === 'courses/100/courseWork') return { courseWork: [coursework] };
      if (path === 'courses/100/courseWork/200') return coursework;
      assert.equal(path, 'courses/100/courseWork/200/studentSubmissions');
      return { studentSubmissions: [submission] };
    },
    async resolveSpeakingCourse() { assert.fail('approved Portal scope must be used'); },
    async verifyCopy(event, options) {
      assert.deepEqual(event, { doc_id: documentId, student_id: googleUserId, submission_id: '400',
        classroom_course_id: courseId, coursework_id: courseWorkId, class_name: classCode });
      assert.deepEqual(options, { speakingCode });
      checks.push(event);
      return { courseId, courseWorkId, assignmentCode: speakingCode, classroomState: 'PUBLISHED', status: 'snapshot',
        submissions: [{ id: '400', userId: googleUserId, documentId }] };
    },
    docs: {
      async read(id) { assert.equal(id, documentId); return structuredClone(document); },
      async write(id, plan) {
        assert.equal(id, documentId);
        assert.equal(plan.revisionId, document.revisionId);
        commitLink(0);
      },
    },
    speakingApi: {
      async scopes() { return { ok: true, assignments: [{ course_id: courseId, course_work_id: courseWorkId,
        assignment_code: speakingCode, class_code: classCode, delivery_mode: 'docs_cta', opened_at: sourceVersion }] }; },
      async sync(snapshot) {
        assert.deepEqual(snapshot, { courseId, courseWorkId, snapshotComplete: true,
          submissions: [{ id: '400', userId: googleUserId, documentId }] });
        roster.set(0, snapshot.submissions[0].userId);
        return { pending: writes.includes(0) ? [] : [{ documentId, classroomSubmissionId: '400', assignmentCode: speakingCode, classCode }] };
      },
      async plan({ document: current }) {
        const run = current.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun;
        const requests = run.textStyle ? [] : [{ updateTextStyle: {
          range: { tabId, startIndex: 1, endIndex: 1 + anchors[0].length },
          fields: 'link,underline,foregroundColor',
          textStyle: { link: { url: links[0] }, underline: true, foregroundColor: {} },
        } }];
        return { documentId, revisionId: current.revisionId, url: links[0], requests };
      },
      async verify({ document: current }) {
        assert.equal(current.tabs[0].documentTab.body.content[0].paragraph.elements[0].textRun.textStyle.link.url, links[0]);
        return { documentId, verified: true, status: 'linked' };
      },
    },
    readingHomework: absent, readingPractice: absent, listeningPractice: absent,
    async listeningHomework(event, code, before, context) {
      await context.assertOwnership();
      assert.equal(event.class_name, classCode);
      assert.equal(event.student_id, googleUserId);
      assert.equal(code, listeningCode);
      assert.equal(before.revisionId, document.revisionId);
      roster.set(1, event.student_id);
      if (!writes.includes(1)) commitLink(1);
      return { documentId, assignmentCode: code, ok: true, status: 'verified', entryUrl: links[1] };
    },
  });
  const token = 'fixture-test-token-at-least-32-characters';
  const server = createK67CtaHttp({ ...stack, token });
  server.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  await once(server, 'listening');
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  async function call(route, body, authorized = true) {
    const res = await fetch(endpoint + route, { method: body ? 'POST' : 'GET',
      headers: authorized ? { authorization: `Bearer ${token}` } : {}, body: body && JSON.stringify(body) });
    return { http: res.status, ...await res.json() };
  }
  assert.equal((await call('/ready')).http, 200);
  const request = { classCode, courseWorkId };
  assert.equal((await call('/manual', request, false)).http, 401);
  if (autoEnroll) assert.equal((await call('/manual', request)).http, 409);
  const first = autoEnroll ? await stack.runtime.tick() : await call('/manual', request);
  assert.equal(first.status, 'done', JSON.stringify(first));
  if (!autoEnroll) assert.equal(first.http, 200, JSON.stringify(first));
  else {
    const { rows } = await db.query(`SELECT owner,epoch,enrolled_erp_class_id FROM reading_listening67.cta_native_owner WHERE course_id=$1`, [courseId]);
    assert.deepEqual(rows, [{ owner: 'backend', epoch: 1, enrolled_erp_class_id: '10' }]);
    assert.ok(events.some(row => row.stage === 'ownership_enrollment' && row.status === 'enrolled' && row.runId === first.runId));
  }
  assert.equal(first.results[0].published, 1);
  const docRequest = { docs: [{ docId: documentId }] };
  assert.equal((await call('/manual-docs/status', docRequest)).results[0].status, 'queued');
  assert.equal((await stack.runtime.workOnce()).status, 'ready', JSON.stringify(events.filter(event => event.errorCode)));
  assert.equal(checks.length, 1);
  assert.deepEqual(paragraphs.slice(0, 2).map(p => p.paragraph.elements[0].textRun.textStyle.link.url), links);
  for (const product of [0, 1]) {
    const canEnter = userId => roster.get(product) === userId;
    assert.equal(canEnter(googleUserId), true);
    assert.equal(canEnter('301'), false);
  }
  assert.deepEqual((await call('/manual-docs/submit', docRequest)).results,
    [{ docId: documentId, status: 'registered', codes: [listeningCode, speakingCode] }]);
  const baselineRevision = document.revisionId;
  const replay = await call('/manual', request);
  assert.equal(replay.http, 200, JSON.stringify(replay));
  assert.equal(replay.results[0].published, 0);
  assert.equal((await stack.runtime.workOnce()).status, 'idle');
  assert.equal(document.revisionId, baselineRevision);
  assert.deepEqual(writes, [0, 1]);
  assert.equal(reads.filter(path => path.endsWith('/studentSubmissions')).length, 2);
  assert.equal((await store.scanStart({ executionId: 'another-legacy-scan' })).acquired, false);
  assert.equal((await store.scanFinish(heldLegacyScan)).status, 'done');
  await db.query(`UPDATE reading_listening67.cta_native_owner SET owner='n8n',epoch=4 WHERE course_id=$1`, [courseId]);
  assert.equal((await call('/manual', request)).http, 409);
});

test('native scans serialize on a separate PostgreSQL session lock and release after failure',
  { skip: !process.env.K67_CTA_REPLAY_DB }, async t => {
    const { pool } = await harness(t);
    const first = createK67NativeScanLock({ pool });
    const second = createK67NativeScanLock({ pool });
    const entered = Promise.withResolvers();
    const finish = Promise.withResolvers();
    const running = first(async () => {
      entered.resolve();
      await finish.promise;
      throw Error('ABANDONED_SCAN');
    });
    const failed = assert.rejects(running, /ABANDONED_SCAN/);
    await entered.promise;
    try {
      assert.equal(await second(() => assert.fail('Concurrent native scan ran')), undefined);
    } finally {
      finish.resolve();
      await failed;
    }
    assert.equal(await second(async () => 'next scan'), 'next scan');
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
  await native.deferBusyDocument(first);
  assert.equal(await native.ownsJob(first), false);
  const contended = await native.claim();
  assert.equal(contended.dispatchToken, first.dispatchToken);
  assert.notEqual(contended.leaseToken, first.leaseToken);
  await assert.rejects(native.deferBusyDocument(first), { code: 'CTA_NATIVE_RECEIPT_UNSAVED' });
  assert.equal(await native.ownsJob(contended), true);
  await h.db.query("UPDATE reading_listening67.cta_native_job SET lease_until=now()-interval '1 minute'");
  const next = await native.claim();
  assert.equal(next.executionId, first.executionId);
  assert.notEqual(next.leaseToken, contended.leaseToken);
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
  const unboundLesson5 = { ...assignment, experience: 'lesson5-consumerism-body-v1',
    classroom: { ...assignment.classroom, courseWorkId: null, ctaCode: 'hw-writing-67-than-bai-mua-sam-khong-can-thiet' } };
  await h.db.query('INSERT INTO assignments VALUES ($1,$2)', ['not-yet-bound', JSON.stringify(unboundLesson5)]);
  const readRegistry = createK67WritingRegistry({ pool: h.db });
  assert.deepEqual((await readRegistry({ courseId, erpClassId: '99' })).map(row => row.id), ['lesson5']);
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
  unboundLesson5.classroom.courseWorkId = '201';
  await h.db.query('UPDATE assignments SET definition=$2 WHERE id=$1', ['not-yet-bound', JSON.stringify(unboundLesson5)]);
  assert.deepEqual((await readRegistry({ courseId, erpClassId: '99' })).map(row => row.id), ['lesson5', 'not-yet-bound']);
  unboundLesson5.classroom.courseWorkId = null;
  unboundLesson5.classroom.ctaCode = 'hw-writing-56-67-other';
  await h.db.query('UPDATE assignments SET definition=$2 WHERE id=$1', ['not-yet-bound', JSON.stringify(unboundLesson5)]);
  await assert.rejects(() => readRegistry({ courseId, erpClassId: '99' }), { code: 'CTA_WRITING_REGISTRY_INVALID' });
});
