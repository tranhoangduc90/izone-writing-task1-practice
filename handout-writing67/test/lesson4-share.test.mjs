import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { readSpeakingShare } from '../src/vendor/chatgpt-share-reader.mjs';
import { PGlite } from '@electric-sql/pglite';
import { createApi } from '../src/http.mjs';
import { createService } from '../src/service.mjs';
import { createStore } from '../src/store.mjs';
import {
  createLesson4ShareWorker, lesson4ShareAnalyzer, lesson4Stages, practiceStatus, queueLesson4Share, LESSON4_SHARE_POLICY,
  LESSON4_STARTER, LESSON4_TOPIC, verifyLesson4Conversation,
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

// Synthetic dialogue with the same order as the false rejection.
const splitChoices = {
  messages: [
    ...complete.messages.slice(0, 7).map(({ role, text }) => [role, text]),
    ['assistant', 'Chọn hai nguyên nhân và hai tác động.'],
    ['user', 'Em đang cân nhắc tâm lý, quảng cáo và lời khuyên.'],
    ['assistant', 'Em chọn tác động nào?'],
    ['user', 'Em chọn tác động lên môi trường, vì sẽ có thêm rác thải.'],
    ['assistant', 'Tác động thứ hai em chọn là gì?'],
    ['user', 'Em chọn người tiêu dùng, vì họ có thể tốn tiền.'],
    ['assistant', 'Em đánh giá xu hướng này thế nào?'],
    ['user', 'Em nghĩ xu hướng này có hại.'],
    ['assistant', 'Thân 1 còn phải chọn hai trong ba nguyên nhân. Thân 2 nói về môi trường và người mua.'],
    ['user', 'Thân 1 em chọn tâm lý và quảng cáo.'],
    ['assistant', 'Dàn ý cuối. Thân 1 giải thích tâm lý và quảng cáo. Thân 2 giải thích tác hại lên môi trường và người mua.'],
  ].map(([role, text], i) => ({ id: 'm' + i, role, text })),
};
const introductoryMilestones = ['analysis', 'reasons', 'effects'].map((stage, i) => ({
  stage, promptId: 'm' + (i * 2 + 1), answerId: 'm' + (i * 2 + 2),
}));
const splitMilestones = [
  ...introductoryMilestones,
  { stage: 'opinion', promptId: 'm13', answerId: 'm14' },
  { stage: 'ideas', body1AnswerIds: ['m16'], body2AnswerIds: ['m10', 'm12'] },
  { stage: 'summary', promptId: 'm17', answerId: null },
];

test('Share accepts separate selections and a body finalized after the opinion', async () => {
  const analyze = lesson4ShareAnalyzer(async ({ prompt }) => ({
    // Replay the old analyzer's first-three-stage outcome for the obsolete evidence contract.
    outputText: JSON.stringify({ milestones: prompt.includes('body1AnswerIds') ? splitMilestones : introductoryMilestones }),
  }));
  const result = await verifyLesson4Conversation(splitChoices, analyze);
  assert.equal(result.status, 'accepted');
});

test('Share requires selections from both bodies and a summary after the last selection', async () => {
  const check = milestones => verifyLesson4Conversation(splitChoices, async () => ({ milestones }));
  const missing = await check(splitMilestones.filter(proof => proof.stage !== 'ideas'));
  assert.equal(missing.status, 'rejected');
  assert.equal(missing.stage, 'ideas');
  const early = await check(splitMilestones.map(proof =>
    proof.stage === 'summary' ? { ...proof, promptId: 'm15' } : proof));
  assert.equal(early.status, 'rejected');
  assert.equal(early.stage, 'summary');
  await assert.rejects(check(splitMilestones.map(proof =>
    proof.stage === 'ideas' ? { ...proof, body2AnswerIds: ['m15'] } : proof)),
    { code: 'SHARE_EVIDENCE_INVALID' });
});

test('Same Share can retry an older evidence error and keeps unrelated reviews pending', () => {
  const url = shareUrl(6);
  const original = { id: 'old-attempt', requestId: 'old-click', url, status: 'needs_review',
    errorCode: 'SHARE_EVIDENCE_INVALID', message: 'Chưa rõ kết quả kiểm.' };
  const session = { practice: original };
  const repeat = queueLesson4Share(session, { url, requestId: original.requestId }, 10);
  assert.equal(repeat.id, original.id);
  const retried = queueLesson4Share(session, { url, requestId: 'new-click' }, 20);
  assert.equal(retried.status, 'queued');
  assert.equal(practiceStatus(original).status, 'retry');
  assert.match(practiceStatus(original).message, /Kiểm tra link/);
  assert.notEqual(retried.id, original.id);
  assert.deepEqual(session.practiceHistory, [original]);
  assert.throws(() => queueLesson4Share(session, { url, requestId: original.requestId }, 21),
    { code: 'SHARE_REQUEST_SUPERSEDED' });

  const uncertain = { ...original, errorCode: 'SHARE_LEASE_EXPIRED' };
  const pendingReview = { practice: uncertain };
  const preserved = queueLesson4Share(pendingReview, { url, requestId: 'new-click' }, 20);
  assert.equal(preserved.id, uncertain.id);
  assert.equal(preserved.status, 'needs_review');
  assert.equal(pendingReview.practiceHistory, undefined);
});

test('Share unlocks only its Writing session and gates the native HTTP save and check', async t => {
  const rows = [{ frame: { id: 'opening', role: 'user', text: '', fileAttachments: [{ kind: 'file' }] } }];
  t.mock.method(https, 'get', (url, options, callback) => {
    assert.equal(url, shareUrl(5));
    const response = Readable.from([Buffer.from(`<!doctype html><script id="octane-conversation-transcript">${JSON.stringify({ rows })}</script>`)]);
    Object.assign(response, { statusCode: 200, headers: {} });
    callback(response);
    return new EventEmitter();
  });
  const fetchHttp = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', (url, options) => String(url).startsWith('http://127.0.0.1:')
    ? fetchHttp(url, options) : Promise.resolve(new Response('{}')));
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
  let splitAnalyses = 0;
  const worker = createLesson4ShareWorker({
    store,
    readShare: async url => {
      if (url === shareUrl(4)) throw Error('reader unavailable');
      if (url === shareUrl(5)) return readSpeakingShare(url);
      if (url === shareUrl(6)) return splitChoices;
      return { messages: complete.messages.slice(0, url === LESSON4_STARTER ? 2 : url === shareUrl(2) ? 10 : 12) };
    },
    analyze: async ({ messages }) => {
      if (messages.at(-1).id === 'm17') {
        splitAnalyses += 1;
        if (splitAnalyses === 1) {
          const [analysis, ...rest] = splitMilestones;
          return { milestones: [{ ...analysis, promptId: analysis.answerId }, ...rest] };
        }
        return { milestones: splitMilestones };
      }
      return { milestones: lesson4Stages.slice(0, messages.length === 9 ? 4 : 6).map((stage, i) => stage === 'ideas'
        ? { stage, body1AnswerIds: ['m8'], body2AnswerIds: ['m8'] }
        : { stage, promptId: 'm' + (i * 2 + 1), answerId: stage === 'summary' ? null : 'm' + (i * 2 + 2) }) };
    },
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
  const readProgress=(studentRef='a',contentVersion=1,auth=entryKey)=>call('/integrations/homework/lesson4/progress',{
    method:'POST',token:auth,body:{classRef:'IC9999',studentRef,assignmentId:'hw-k67-writing-lesson4-9999',contentVersion},
  });
  const { session, token } = await open('a');
  assert.equal((await readProgress('a',1,token)).status,403);
  assert.equal((await readProgress('a',2)).body.progress,null);
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
  for (const [url, expected, message] of [[LESSON4_STARTER, 'rejected'], [shareUrl(2), 'rejected'],
    [shareUrl(4), 'retry', 'Chưa đọc được link. Kiểm tra link chia sẻ công khai rồi thử lại.'],
    [shareUrl(5), 'retry', 'Chưa đọc được nội dung đoạn chat của em vì nó khởi đầu bằng một tệp. Em hãy quay lại nhấn Mở bài luyện và chat ngay trong đoạn chat vừa mở. Nếu vẫn không được, hãy gửi link cho giảng viên kèm theo ảnh chụp màn hình để được hỗ trợ.'],
    [shareUrl(3), 'accepted']]) {
    assert.equal((await send('/practice', { url, requestId: 'try-' + url.at(-1) })).status, 202);
    assert.equal(await worker(), true);
    const { practice } = (await get('/practice')).body;
    assert.equal(practice.status, expected);
    if (message) assert.equal(practice.message, message);
  }
  const badEvidence = { url: shareUrl(6), requestId: 'try-6' };
  assert.equal((await send('/practice', badEvidence)).status, 202);
  assert.equal(await worker(), true);
  const failed = (await get('/practice')).body.practice;
  assert.equal((await readProgress()).body.progress.accepted, false);
  const sameClick = await send('/practice', badEvidence);
  assert.equal(sameClick.status, 200);
  assert.equal(sameClick.body.practice.id, failed.id);
  assert.equal(await worker(), false);
  assert.equal(splitAnalyses, 1);

  const retryClick = { ...badEvidence, requestId: 'try-6-again' };
  const retry = await send('/practice', retryClick);
  assert.equal(retry.status, 202);
  assert.notEqual(retry.body.practice.id, failed.id);
  assert.equal(retry.body.practice.url, failed.url);
  assert.equal(failed.status, 'retry');
  assert.match(failed.message, /Kiểm tra link/);
  const duplicate = await send('/practice', { ...badEvidence, requestId: 'try-6-while-queued' });
  assert.equal(duplicate.body.practice.id, retry.body.practice.id);
  assert.equal(await worker(), true);
  const passed = (await get('/practice')).body.practice;
  assert.equal(passed.id, retry.body.practice.id);
  assert.equal(passed.status, 'accepted');
  const afterAccept = await send('/practice', { ...badEvidence, requestId: 'try-6-after-accept' });
  assert.deepEqual(afterAccept.body.practice, passed);
  assert.equal(await worker(), false);
  assert.equal(splitAnalyses, 2);
  const previous = (await store.read(session.ref)).practiceHistory.find(item => item.id === failed.id);
  assert.equal(previous.errorCode, 'SHARE_EVIDENCE_INVALID');

  assert.equal((await call('/sessions/' + other.session.ref, { token: other.token })).body.session.practice.status, 'not_started');
  assert.equal((await send('/responses', draft, 'PUT')).status, 200);
  assert.equal((await send('/checks', check)).status, 202);
  const first = (await service.claim()).find(job => job.section === 'body1_topic');
  assert.ok(first);
  await service.complete({ ...first, result: { resultStatus: 'passed', feedback: 'Hai ý giải thích đúng lý do.' } });
  assert.deepEqual((await readProgress()).body.progress.bodies.map(b=>b.passed),[true,false]);
  assert.deepEqual((await readProgress('b')).body.progress.bodies.map(b=>b.passed),[false,false]);
  const secondDraft = { requestId: 'save-2', baseVersion: 1, responses: {
    body2_topicSentence: 'Việc mua quá nhiều có hại vì gây lãng phí và thêm rác.',
    body2_idea1: 'Tốn tiền cho đồ ít dùng', body2_idea2: 'Vứt đồ cũ còn dùng được',
  } };
  assert.equal((await send('/responses', secondDraft, 'PUT')).status, 200);
  assert.equal((await send('/checks', { ...check, baseVersion: 2, requestId: 'check-2', section: 'body2_topic', bodyIndex: 2 })).status, 202);
  const second = (await service.claim()).find(job => job.section === 'body2_topic');
  assert.ok(second);
  await service.complete({ ...second, result: { resultStatus: 'passed', feedback: 'Hai ý làm rõ đánh giá tiêu cực.' } });
  const progress=(await readProgress()).body.progress;
  assert.deepEqual(progress.bodies.map(b=>b.passed),[true,true]);
  assert.deepEqual(progress.bodies.map(b=>b.jobRef),[first.jobRef,second.jobRef]);
  assert.deepEqual(Object.keys(progress).sort(),['accepted','bodies','ref','version']);
  const restored = (await get('')).body.session;
  assert.equal(restored.completed, true);
  assert.equal(restored.responses.body1_idea1, draft.responses.body1_idea1);
  assert.equal(Object.keys(restored.responses).length, 6);
  const events = (await db.query("SELECT kind,details FROM handout67.activity_event WHERE session_ref=$1 AND kind LIKE 'share_%'", [session.ref])).rows;
  assert.ok(['share_accepted', 'share_rejected', 'share_retry'].every(kind => events.some(event => event.kind === kind)));
  const classified = events.filter(event => event.details.readDetail === 'FIRST_USER_ATTACHMENT_ONLY');
  assert.equal(classified.length, 1);
  assert.equal(classified[0].details.error, 'SHARE_READ_FAILED');
  const checked = events.filter(event => event.details.recognizerVersion === 'lesson4-share-evidence-v2');
  assert.equal(checked.filter(event => event.kind === 'share_accepted').length, 2);
  assert.equal(checked.find(event => event.details.stage === 'opinion')?.kind, 'share_rejected');
  assert.equal(checked.find(event => event.details.practiceId === failed.id)?.details.error, 'SHARE_EVIDENCE_INVALID');
  assert.equal(checked.find(event => event.details.practiceId === failed.id)?.kind, 'share_retry');
  assert.ok(!JSON.stringify(events).includes('chatgpt.com'));
  const changed = await send('/responses', { requestId: 'edit-1', baseVersion: 2, responses: { body1_idea1: 'Mua sắm để cải thiện tâm trạng' } }, 'PUT');
  assert.equal(changed.body.session.steps.body1_topic.status, 'revision');
  assert.equal(changed.body.session.steps.body2_topic.status, 'passed');
  assert.equal(changed.body.session.steps.body1_topic.history.length, 1);
});
