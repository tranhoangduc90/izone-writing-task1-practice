import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { createApi } from '../src/http.mjs';
import { createStore, postgresAdapter } from '../src/store.mjs';
import { createService } from '../src/service.mjs';
import { createProcessor } from '../src/processor.mjs';
import { createNativeDispatch } from '../src/native-dispatch.mjs';
import { LESSON6_TOPIC, LESSON6_SHARE_POLICY } from '../src/writing-lesson6.mjs';

const origin = 'https://pages.example.test';
const writingEntryKey = 'handout-test-bridge-key';
const classRef = 'IC9996';
const assignmentId = 'hw-k67-writing-lesson6-9996';
const scope = (studentRef, overrides = {}) => ({ classRef, studentRef, assignmentId, contentVersion: 1, ...overrides });
const initial = {
  stance: 'disagree', body1_topicSentence: 'Uncontrolled information can cause harm.',
  body1_idea1: 'False public health claims can spread before they are corrected.',
  body2_topicSentence: 'Fast access to information and sharing can save lives and widen access to learning.',
  body2_idea1: 'Families can access evacuation notices immediately on their phones.',
  body2_idea2: 'Teachers can share open lessons with learners in isolated areas.',
};

async function fixture(t) {
  const url = process.env.HANDOUT67_QA_POSTGRES_URL;
  if (url && url !== 'postgresql://lab@postgres:5432/lab') throw Error('HANDOUT_QA_DATABASE_NOT_ISOLATED');
  const db = url ? new (await import('pg')).default.Pool({ connectionString: url, max: 4 }) : new PGlite();
  if (url) assert.deepEqual((await db.query('SELECT current_database() AS db, current_user AS role')).rows[0], { db: 'lab', role: 'lab' });
  for (const file of ['001-initial.sql', '002-activity-log.sql']) {
    const sql = await readFile(new URL('../db/' + file, import.meta.url), 'utf8');
    await (url ? db.query(sql) : db.exec(sql));
  }
  const store = createStore(url ? postgresAdapter(db) : db);
  const students = ['owner', 'one', 'unfinished', 'coverage', 'other', 'prior', 'stale'].map(studentRef => ({ studentRef }));
  const lesson6 = { activity: 'lesson6', topic: LESSON6_TOPIC, classes: [classRef], outlineOnly: true,
    handoutMode: 'two-bodies-v1', workflowMode: 'whole-chain-v1', sharePolicy: LESSON6_SHARE_POLICY,
    bodies: [{ body: 1 }, { body: 2 }], promptVersion: 'test-lesson6' };
  const lesson7 = { activity: 'lesson7', topic: LESSON6_TOPIC, body: 2, classes: [classRef], promptVersion: 'test-lesson7' };
  const service = createService({ store, roster: async () => [{ classRef, className: classRef, students }], lessons: { lesson6, lesson7 },
    lesson7HomeworkImport: true, secret: 'lesson7-test-secret-key'.repeat(2), renderJob: job => 'Topic check ' + job.section });
  const server = createApi({ service, origins: [origin], internalSecret: 'test', writingEntryKey, nativeWake: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const api = `http://127.0.0.1:${server.address().port}/api/handout67/v1`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await (url ? db.end() : db.close()); });
  async function http(path, { method = 'GET', body, token, bridge, etag, caller } = {}) {
    const response = await fetch(api + path, { method, headers: { ...(body && { 'Content-Type': 'application/json' }),
      ...(token && { Authorization: 'Bearer ' + token }), ...(bridge && { 'X-Handout67-Writing-Entry': writingEntryKey }),
      ...(etag && { 'If-None-Match': etag }), ...(caller && { Origin: caller }) }, ...(body && { body: JSON.stringify(body) }) });
    return { status: response.status, etag: response.headers.get('etag'), body: response.status === 304 ? null : await response.json() };
  }
  async function seed(studentRef, responses = {}, status = 'passed', dimensions = ['access', 'exchange']) {
    const { session, token } = await service.open({ activity: 'lesson6', classRef, studentRef, writingEntry: { assignmentId, contentVersion: 1 } });
    await store.edit(session.ref, draft => {
      draft.practice = { id: randomUUID(), status: 'accepted', policy: LESSON6_SHARE_POLICY };
      Object.assign(draft.responses, initial, responses);
      draft.steps.body1_topic = { status: 'passed', direction: 'agree', dimensions: ['rapid', 'uncontrolled'],
        history: [{ status: 'passed', jobRef: randomUUID() }] };
      draft.steps.body2_topic = { status, direction: 'disagree', dimensions, history: [{ status, jobRef: randomUUID() }] };
      draft.version = 6;
    });
    return { sourceRef: session.ref, sourceVersion: 6, token };
  }
  const callTransfer = (payload, options) => http('/integrations/homework/lesson7/transfer',
    { method: 'POST', body: payload, token: writingEntryKey, ...options });
  const openVerified = studentRef => http('/integrations/homework/lesson7/open', { method: 'POST', body: scope(studentRef), token: writingEntryKey });
  const openNameOnly = studentRef => http('/sessions', { method: 'POST', body: { activity: 'lesson7', classRef, studentRef } });
  return { api, db, store, service, http, seed, callTransfer, openVerified, openNameOnly };
}

test('L6 → L7 locks both identities, preserves drafts and completes Topic in the native dispatcher', async t => {
  const h = await fixture(t);
  const prior = (await h.openNameOnly('owner')).body;
  const ref = '/sessions/' + prior.session.ref;
  assert.equal((await h.http(ref + '/responses', { method: 'PUT', token: prior.token,
    body: { baseVersion: prior.session.version, requestId: randomUUID(), responses: { idea1: 'My initial idea' } } })).status, 200);
  const { sourceRef, sourceVersion, token: sourceToken } = await h.seed('owner');
  const source = await h.http('/sessions/' + sourceRef, { token: sourceToken, bridge: true });
  assert.deepEqual(source.body.session.lesson7Transfer, { eligible: true, version: 6 });
  const transfer = { ...scope('owner'), sourceRef, sourceVersion, requestId: randomUUID() };
  assert.equal((await h.callTransfer(transfer, { caller: origin })).status, 403);
  assert.equal((await h.callTransfer({ ...transfer, studentRef: 'other' })).status, 403);
  assert.equal((await h.callTransfer({ ...transfer, classRef: 'IC9998' })).status, 403);
  assert.equal((await h.callTransfer({ ...transfer, contentVersion: 2 })).status, 403);
  assert.equal((await h.callTransfer({ ...transfer, assignmentId: 'hw-k67-writing-lesson4-9996' })).status, 403);
  assert.equal((await h.callTransfer({ ...transfer, sourceVersion: 5 })).status, 409);
  const homeworkEditorPath = process.env.HANDOUT67_QA_HOMEWORK_EDITOR;
  let viaHomework;
  if (homeworkEditorPath) {
    const { createLesson3Editor } = await import(pathToFileURL(homeworkEditorPath).href);
    const editor = createLesson3Editor({ upstream: h.api, writingEntryKey });
    const assignment = { id: assignmentId, definition: { authorityClassId: 9996, contentVersion: 1, handoutClassRef: classRef,
      experience: 'lesson6-information-ideas-v1', classroom: { ctaCode: 'hw-writing-67-idea-truy-cap-trao-doi-thong-tin', ctaLayout: 'button' } } };
    const owner = { role: 'student', studentBinding: { authorityClassId: 9996, studentRef: 'owner' }, entryBinding: { assignmentId, contentVersion: 1 } };
    const options = { method: 'POST', path: '/sessions/' + sourceRef + '/lesson7-transfer', token: 'Bearer ' + sourceToken,
      payload: { sourceVersion, requestId: transfer.requestId, studentRef: 'other' } };
    await assert.rejects(() => editor({ ...owner, entryBinding: null }, assignment, options), error => error.status === 403);
    await assert.rejects(() => editor({ ...owner, studentBinding: { ...owner.studentBinding, studentRef: 'other' } }, assignment, options), error => error.status === 403);
    viaHomework = (path, action = {}) => editor(owner, assignment, { method: 'GET', path, ...action });
    const response = await editor(owner, assignment, options);
    assert.equal(response.status, 200);
    assert.equal(response.body.transfer.status, 'applied');
  }
  const results = await Promise.all([h.callTransfer(transfer), h.callTransfer(transfer)]);
  assert.deepEqual(results.map(row => row.body.transfer.status).sort(), [viaHomework ? 'unchanged' : 'applied', 'unchanged']);
  const reentry = viaHomework ? await viaHomework('/lesson7/sessions', { method: 'POST', payload: { activity: 'lesson7', classRef, studentRef: 'owner' } }) : await h.openVerified('owner');
  assert.equal(reentry.status, 201);
  const { session, token } = reentry.body;
  assert.equal(session.ref, prior.session.ref);
  const lesson7Scope=scope('owner',{assignmentId:'hw-k67-writing-lesson7-9996'});
  const writing=options=>h.http('/integrations/homework/lesson7/open-writing',{method:'POST',body:lesson7Scope,...options});
  assert.equal((await writing()).status,403);
  assert.equal((await writing({token:writingEntryKey,caller:origin})).status,403);
  assert.equal((await writing({token:writingEntryKey,body:{...lesson7Scope,assignmentId:'hw-k67-writing-lesson7-9998'}})).status,403);
  const writer=await writing({token:writingEntryKey});
  assert.equal(writer.status,201);
  assert.equal(writer.body.session.ref,session.ref);
  const readOutline=body=>h.http('/integrations/homework/lesson7/writing-outline',{method:'POST',body,token:writingEntryKey});
  assert.equal((await readOutline({...lesson7Scope,studentRef:'missing'})).status,403);
  assert.equal((await readOutline(lesson7Scope)).body.outline.approved,false);
  const newScope=scope('other',{assignmentId:lesson7Scope.assignmentId});
  const blank=await writing({token:writingEntryKey,body:newScope});
  assert.equal(blank.status,201);
  assert.notEqual(blank.body.session.ref,session.ref);
  assert.equal((await readOutline(newScope)).body.outline.approved,false);

  assert.deepEqual(session.lesson7IdeaSource, { fields: ['idea2'], sourceVersion: 6, stance: 'disagree' });
  assert.equal(session.responses.idea1, 'My initial idea');
  assert.equal(session.responses.idea2, initial.body2_idea2);
  assert.equal(session.responses.topicSentence, '');
  const read = await h.http(ref, { token, bridge: true });
  assert.equal(read.status, 200);
  assert.equal((await h.http(ref, { token, bridge: true, etag: read.etag })).status, 304);
  assert.equal((await h.http(ref, { token: prior.token, etag: read.etag })).status, 403);
  assert.equal((await h.http(ref, { token, etag: read.etag })).status, 403);
  assert.equal((await h.openNameOnly('owner')).status, 403);
  assert.equal((await h.http(ref + '/responses', { method: 'PUT', token: prior.token,
    body: { baseVersion: session.version, requestId: randomUUID(), responses: { idea2: 'Wrong authorization' } } })).status, 403);
  assert.equal((await h.db.query("SELECT COUNT(*)::int AS count FROM handout67.activity_event WHERE kind='lesson7_homework_ideas_applied'")).rows[0].count, 1);

  const body = { baseVersion: session.version, requestId: randomUUID(), responses: { topicSentence: initial.body2_topicSentence } };
  const saved = await h.http(ref + '/responses', { method: 'PUT', token, bridge: true, body });
  const check = await h.http(ref + '/checks', { method: 'POST', token, bridge: true,
    body: { baseVersion: saved.body.session.version, section: 'topic', requestId: randomUUID() } });
  assert.equal(check.status, 202);
  const processor = createProcessor({ service: h.service, async callAI(job) {
    assert.equal(job.snapshot.responses.idea2, initial.body2_idea2);
    return { outputText: JSON.stringify({ operation_key: job.operationKey,
      result: { resultStatus: 'passed', feedback: 'Fixture confirms this Topic.' } }), model: 'fixture', httpStatus: 200 };
  } });
  const receipt = Promise.withResolvers();
  const native = createNativeDispatch({ service: h.service, processor, hasWork: async () => true,
    onReceipt: receipt.resolve, onError: receipt.reject });
  try {
    native.request();
    const finished = await Promise.race([receipt.promise, new Promise((_, reject) => setTimeout(() => reject(Error('Native Check timed out')), 4000).unref())]);
    const reloaded = await h.http(ref, { token, bridge: true });
    assert.equal(reloaded.body.session.steps.topic.status, 'passed');
    assert.equal(reloaded.body.session.steps.topic.history[0].jobRef, finished.jobRef);
    assert.equal((await h.callTransfer(transfer)).body.transfer.status, 'unchanged');
  } finally { native.close(); processor.close(); }
});

test('L7 imports an optional single idea and leaves rejected or previously checked drafts alone', async t => {
  const h = await fixture(t);
  for (const [student, changes, status, dimensions] of [
    ['one', { body2_idea2: '' }], ['unfinished', {}, 'draft'], ['coverage', {}, 'passed', ['access']],
  ]) {
    const { sourceRef, sourceVersion } = await h.seed(student, changes, status, dimensions);
    const answer = await h.callTransfer({ ...scope(student), sourceRef, sourceVersion, requestId: randomUUID() });
    if (student === 'one') {
      assert.deepEqual(answer.body.transfer.fields, ['idea1']);
      assert.equal((await h.openVerified(student)).body.session.responses.idea2, '');
    } else {
      assert.equal(answer.status, 409);
      assert.equal(answer.body.error, 'LESSON7_SOURCE_INCOMPLETE');
      assert.equal(await h.store.readIdentity(JSON.stringify(['lesson7', classRef, student])), undefined);
    }
  }
  const { sourceRef, sourceVersion } = await h.seed('prior');
  const prior = (await h.openNameOnly('prior')).body.session;
  await h.store.edit(prior.ref, draft => {
    draft.responses.idea1 = 'Previous idea';
    draft.steps.topic.history.push({ status: 'revision', feedback: 'Already checked once.' });
  });
  const answer = await h.callTransfer({ ...scope('prior'), sourceRef, sourceVersion, requestId: randomUUID() });
  assert.equal(answer.body.transfer.status, 'unchanged');
  assert.equal((await h.openNameOnly('prior')).body.session.responses.idea1, 'Previous idea');
});
