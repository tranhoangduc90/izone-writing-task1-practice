import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createApi } from '../src/http.mjs';
import { createService } from '../src/service.mjs';
import { createStore } from '../src/store.mjs';
import {
  createLesson4ShareWorker, lesson4Stages, LESSON4_SHARE_POLICY, LESSON4_STARTER, LESSON4_TOPIC,
} from '../src/writing-lesson4-share.mjs';

const lesson = {
  activity: 'lesson4', classes: ['IC9999'], outlineOnly: true, handoutMode: 'two-bodies-v1',
  workflowMode: 'whole-chain-v1', topic: LESSON4_TOPIC, promptVersion: 'lesson4-rubric-v1',
  sharePolicy: LESSON4_SHARE_POLICY,
};
const complete = {
  messages: [
    ['user', 'Prompt khởi động'],
    ['assistant', LESSON4_TOPIC + ' Đề yêu cầu gì và trọng tâm là gì?'],
    ['user', 'Giải thích nguyên nhân mua đồ không cần và nêu việc đó tốt hay xấu.'],
    ['assistant', 'Vì sao người ta mua?'],
    ['user', 'Giảm căng thẳng và bị quảng cáo tác động.'],
    ['assistant', 'Thói quen đó ảnh hưởng đến ai?'],
    ['user', 'Người mua có thể mất tiền và môi trường chịu thêm rác.'],
    ['assistant', 'Chọn hai ý cho mỗi thân.'],
    ['user', 'Thân 1 dùng giảm căng thẳng và quảng cáo. Thân 2 dùng tốn tiền và tăng rác.'],
    ['assistant', 'Bạn đánh giá thói quen này thế nào?'],
    ['user', 'Nhìn chung có hại.'],
    ['assistant', 'Thân 1 nói về tâm lý và quảng cáo. Thân 2 giải thích vì sao có hại do tốn tiền và tăng rác.'],
  ].map(([role, text], i) => ({ id: 'm' + i, role, text })),
};
const shareUrl = id => 'https://chatgpt.com/share/00000000-0000-4000-8000-00000000000' + id;

test('Share unlocks only its Writing session and gates the native HTTP save and check', async t => {
  const db = new PGlite();
  for (const file of ['001-initial.sql', '002-activity-log.sql']) {
    await db.exec(await readFile(new URL('../db/' + file, import.meta.url), 'utf8'));
  }
  const store = createStore(db);
  const secret = 'test-internal-secret'.padEnd(40, 'x');
  const service = createService({
    store, secret: 'test-session-secret'.padEnd(40, 'x'), lessons: { lesson4: lesson },
    roster: async () => [{ classRef: 'IC9999', students: [{ studentRef: 'a' }, { studentRef: 'b' }] }],
    renderJob: () => 'Outline grading fixture',
  });
  const worker = createLesson4ShareWorker({
    store,
    readShare: async url => {
      if (url === shareUrl(4)) throw Error('reader unavailable');
      return { messages: complete.messages.slice(0, url === LESSON4_STARTER ? 2 : url === shareUrl(2) ? 10 : 12) };
    },
    analyze: async ({ messages }) => ({ milestones: lesson4Stages.slice(0, messages.length === 9 ? 4 : 6).map((stage, i) => ({
      stage, promptId: 'm' + (i * 2 + 1), answerId: stage === 'summary' ? null : 'm' + (i * 2 + 2),
    })) }),
  });
  const entryKey = 'test-writing-entry'.padEnd(40, 'x');
  const server = createApi({ service, origins: [], internalSecret: secret, writingEntryKey: entryKey });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await db.close(); });
  const base = 'http://127.0.0.1:' + server.address().port + '/api/handout67/v1';
  const call = async (path, { method = 'GET', token, body } = {}) => {
    const response = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', 'X-Handout67-Writing-Entry': entryKey, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body && JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const open = async studentRef => {
    const response = await call('/sessions', { method: 'POST', token: entryKey, body: { activity: 'lesson4', classRef: 'IC9999', studentRef, writingEntry: { assignmentId: 'hw-k67-writing-lesson4-9999', contentVersion: 1 } } });
    assert.equal(response.status, 201);
    return response.body;
  };
  const { session, token } = await open('a');
  assert.equal((await call('/sessions', { method: 'POST', body: { activity: 'lesson4', classRef: 'IC9999', studentRef: 'a' } })).status, 403);
  const other = await open('b');
  const path = '/sessions/' + session.ref;
  const get = suffix => call(path + suffix, { token });
  const send = (suffix, body, method = 'POST') => call(path + suffix, { token, method, body });
  const draft = { requestId: 'save-1', baseVersion: 0, responses: {
    body1_topicSentence: 'Người ta mua vì tâm lý và quảng cáo.',
    body1_idea1: 'Cải thiện tâm trạng', body1_idea2: 'Ưu đãi thúc đẩy mua bốc đồng',
  } };
  const check = { requestId: 'check-1', baseVersion: 1, section: 'body1_topic', bodyIndex: 1 };
  assert.equal((await send('/responses', draft, 'PUT')).body.error, 'PRACTICE_NOT_ACCEPTED');
  assert.equal((await send('/checks', check)).body.error, 'PRACTICE_NOT_ACCEPTED');
  assert.equal((await call(path + '/practice', { token: other.token })).status, 401);
  for (const [url, expected] of [[LESSON4_STARTER, 'rejected'], [shareUrl(2), 'rejected'], [shareUrl(4), 'retry'], [shareUrl(3), 'accepted']]) {
    assert.equal((await send('/practice', { url, requestId: 'try-' + url.at(-1) })).status, 202);
    assert.equal(await worker(), true);
    assert.equal((await get('/practice')).body.practice.status, expected);
  }
  assert.equal((await call('/sessions/' + other.session.ref, { token: other.token })).body.session.practice.status, 'not_started');
  assert.equal((await send('/responses', draft, 'PUT')).status, 200);
  assert.equal((await send('/checks', check)).status, 202);
  const first = (await service.claim()).find(job => job.section === 'body1_topic');
  assert.ok(first);
  await service.complete({ ...first, result: { resultStatus: 'passed', feedback: 'Hai ý giải thích đúng lý do.' } });
  const secondDraft = { requestId: 'save-2', baseVersion: 1, responses: {
    body2_topicSentence: 'Việc mua quá nhiều có hại vì gây lãng phí và thêm rác.',
    body2_idea1: 'Tốn tiền cho đồ ít dùng', body2_idea2: 'Vứt đồ cũ còn dùng được',
  } };
  assert.equal((await send('/responses', secondDraft, 'PUT')).status, 200);
  assert.equal((await send('/checks', { ...check, baseVersion: 2, requestId: 'check-2', section: 'body2_topic', bodyIndex: 2 })).status, 202);
  const second = (await service.claim()).find(job => job.section === 'body2_topic');
  assert.ok(second);
  await service.complete({ ...second, result: { resultStatus: 'passed', feedback: 'Hai ý làm rõ đánh giá tiêu cực.' } });
  const restored = (await get('')).body.session;
  assert.equal(restored.completed, true);
  assert.equal(restored.responses.body1_idea1, draft.responses.body1_idea1);
  assert.equal(Object.keys(restored.responses).length, 6);
  const events = (await db.query("SELECT kind,details FROM handout67.activity_event WHERE session_ref=$1 AND kind LIKE 'share_%'", [session.ref])).rows;
  assert.ok(['share_accepted', 'share_rejected', 'share_retry'].every(kind => events.some(event => event.kind === kind)));
  assert.ok(!JSON.stringify(events).includes('chatgpt.com'));
  const changed = await send('/responses', { requestId: 'edit-1', baseVersion: 2, responses: { body1_idea1: 'Mua sắm để cải thiện tâm trạng' } }, 'PUT');
  assert.equal(changed.body.session.steps.body1_topic.status, 'revision');
  assert.equal(changed.body.session.steps.body2_topic.status, 'passed');
  assert.equal(changed.body.session.steps.body1_topic.history.length, 1);
});
