import assert from 'node:assert/strict';
import crypto from 'node:crypto';

// Dữ liệu nhận vào: URL API, slug activity và ba UUID kiểm thử không chứa thông tin học viên thật.
// Việc chính: mở phiên, lưu ý, kiểm tra khóa bước, gọi AI ở từng bước, nhận từ vựng và kết quả Draft LMS.
// Kết quả: in JSON trạng thái ngắn cho từng cổng; không in prompt, bài viết hoặc credential.
// Khi lỗi: dừng tại đúng cổng và trả mã/lỗi API để có thể rollback trước khi mở cho lớp thật.

const apiBase = new URL(process.env.API_BASE || 'http://127.0.0.1:8791/api/v1/');
const activitySlug = process.env.ACTIVITY_SLUG || 'writing-task2-public-health-ban';
const classRef = process.env.CLASS_REF || '71823175-f987-4d69-8cd6-51abb7ec6566';
const studentRef = process.env.STUDENT_REF || '782c4f2f-17ce-48cb-85f5-ad879c1c3e48';
const mode = process.env.MODE || 'preflight';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const id = () => crypto.randomUUID();

async function request(pathname, options = {}, expected = [200, 201, 202]) {
  const response = await fetch(new URL(pathname, apiBase), {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!expected.includes(response.status)) {
    const error = new Error(`${pathname}: HTTP ${response.status} ${data.error || data.message || ''}`.trim());
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

const emit = (gate, detail = {}) => process.stdout.write(`${JSON.stringify({ gate, ok: true, ...detail })}\n`);

let session = (await request('lesson-sessions', {
  method: 'POST',
  body: JSON.stringify({ activitySlug, classRef, studentRef })
})).session;
emit('open_session', { sections: session.sectionDefinitions.map(item => item.section) });

const responses = {
  body1_message: 'A ban is justified because it would reduce routine exposure to proven harmful products and protect vulnerable consumers.',
  body1_idea1: 'Removing these products from ordinary shops would make repeated and impulse consumption less convenient.',
  body1_idea2: 'A ban would protect children and consumers with limited health literacy from products they may struggle to assess or avoid.',
  body2_message: 'A complete ban may be disproportionate because risk depends on consumption patterns and less restrictive regulation can protect health while preserving choice.',
  body2_idea1: 'Scientific findings and safe-consumption thresholds can change, so a permanent ban may overreach.',
  body2_idea2: 'Warning labels, taxes and placement restrictions can discourage harmful consumption without eliminating adult choice.',
  body_choice: 'body1',
  topic_sentence: 'I agree with this proposal.',
  idea1_a: 'Harmful food is available in shops.',
  idea1_x: 'This is bad.',
  idea1_b: 'People get sick.',
  idea2_a: '', idea2_x: '', idea2_b: '', draft1: '', draft2: ''
};

async function save(patch) {
  Object.assign(responses, patch);
  session = (await request(`lesson-sessions/${session.sessionRef}/responses`, {
    method: 'PUT',
    body: JSON.stringify({ baseVersion: session.draftVersion, requestId: id(), responses })
  })).session;
  return session;
}

await save({});
emit('save_planning', { draftVersion: session.draftVersion });

try {
  await request(`lesson-sessions/${session.sessionRef}/checks`, {
    method: 'POST', body: JSON.stringify({ section: 'supporting_idea_1', requestId: id() })
  });
  throw new Error('Supporting Idea 1 đã chạy trước khi Topic Sentence đạt.');
} catch (error) {
  assert.equal(error.status, 409);
  assert.equal(error.data?.error, 'SECTION_PREREQUISITES_NOT_PASSED');
  emit('prerequisite_gate');
}

if (mode === 'preflight') {
  emit('preflight_complete');
  process.exit(0);
}

async function waitForAttempt(attemptRef) {
  const started = Date.now();
  while (Date.now() - started < 420_000) {
    const attempt = (await request(`attempts/${attemptRef}`)).attempt;
    if (attempt.status === 'completed') return attempt;
    if (attempt.status === 'failed') throw new Error(`${attempt.section}: ${attempt.errorCode || 'technical_error'}`);
    await wait(2000);
  }
  throw new Error(`Hết thời gian chờ attempt ${attemptRef}.`);
}

async function check(section, verifyIdempotency = false) {
  const requestId = id();
  const first = (await request(`lesson-sessions/${session.sessionRef}/checks`, {
    method: 'POST', body: JSON.stringify({ section, requestId })
  })).attempt;
  if (verifyIdempotency) {
    const second = (await request(`lesson-sessions/${session.sessionRef}/checks`, {
      method: 'POST', body: JSON.stringify({ section, requestId })
    })).attempt;
    assert.equal(second.attemptRef, first.attemptRef);
    assert.equal(second.idempotent, true);
    emit('double_click_idempotency', { section });
  }
  const result = await waitForAttempt(first.attemptRef);
  emit('ai_check', { section, result: result.resultStatus, commentNumber: result.commentNumber });
  return result;
}

const weakTopic = await check('topic_sentence', true);
assert.equal(weakTopic.resultStatus, 'needs_revision');
await save({
  topic_sentence: 'Shops should be prohibited from selling food and drinks proven to harm public health because removing these products from routine retail settings would reduce habitual exposure and protect consumers who are especially vulnerable to health risks.'
});
let topic = await check('topic_sentence');
if (topic.resultStatus !== 'passed') {
  await save({
    topic_sentence: 'Banning shops from selling scientifically proven harmful food and drinks is justified because it would both reduce consumers’ routine exposure to these products and protect vulnerable groups who cannot reliably assess or avoid the health risks.'
  });
  topic = await check('topic_sentence');
}
assert.equal(topic.resultStatus, 'passed');
emit('topic_sentence_locked');

const weakIdea1 = await check('supporting_idea_1');
assert.equal(weakIdea1.resultStatus, 'needs_revision');
await save({
  idea1_a: 'When scientifically proven harmful products remain on ordinary shop shelves, consumers can buy them easily during routine trips.',
  idea1_x: 'This convenience encourages frequent or impulsive purchases, so occasional consumption can become a repeated part of people’s diets.',
  idea1_b: 'Removing these products from retail outlets would therefore reduce sustained exposure to known health risks and lower preventable diet-related illness.'
});
let idea1 = await check('supporting_idea_1');
if (idea1.resultStatus !== 'passed') {
  await save({
    idea1_x: 'Because the products are visible and immediately available during routine shopping, consumers face repeated cues to buy them, which turns occasional intake into a persistent dietary habit.'
  });
  idea1 = await check('supporting_idea_1');
}
assert.equal(idea1.resultStatus, 'passed');
emit('supporting_idea_1_locked');

await save({
  idea2_a: 'Children and people with limited health literacy are less able to judge technical evidence about the risks of heavily processed food and drinks.',
  idea2_x: 'Low prices, prominent displays and persuasive marketing can therefore lead these groups to choose harmful products without fully understanding the long-term consequences.',
  idea2_b: 'A sales ban would stop retailers from exploiting this information gap and give vulnerable consumers stronger protection from avoidable disease.'
});
let idea2 = await check('supporting_idea_2');
if (idea2.resultStatus !== 'passed') {
  await save({
    idea2_x: 'Because these consumers cannot readily interpret scientific warnings, cheap prices and prominent advertising can repeatedly steer them toward risky products before they understand the cumulative harm.',
    idea2_b: 'Preventing those sales would close this information gap and reduce avoidable disease among the groups least able to protect themselves.'
  });
  idea2 = await check('supporting_idea_2');
}
assert.equal(idea2.resultStatus, 'passed');
assert.ok(Array.isArray(idea2.artifacts?.vocabulary) && idea2.artifacts.vocabulary.length > 0);
emit('vocabulary_unlocked', { rows: idea2.artifacts.vocabulary.length });

await save({
  draft1: 'Banning harmful food and drinks from shops would reduce everyday exposure and protect vulnerable consumers. Easy retail access encourages repeated purchases and can turn occasional consumption into an unhealthy habit. Children and people with limited health literacy are also less able to understand scientific risk information. A ban would therefore reduce preventable illness and protect those least able to avoid it.',
  draft2: 'Banning harmful food and drinks from shops would reduce everyday exposure and protect vulnerable consumers. Easy retail access encourage repeated purchases and can turn occasional consumption into an unhealthy habit. Children and people with limited health literacy are also less able to interpret scientific risk information. A ban would therefore reduce preventable illness and better protect those least able to avoid it.'
});
const draft = await check('draft');
assert.equal(draft.resultStatus, 'passed');
assert.match(draft.artifacts?.lmsUrl || '', /^https:\/\/practice\.izone\.edu\.vn\/shared\/writing-essays\//i);
const draftResult = await request(`lesson-sessions/${session.sessionRef}/draft-result`);
assert.equal(draftResult.ok, true);
emit('draft_lms_result', { resultType: draft.artifacts.resultType, hasInlineResult: true });

session = (await request(`lesson-sessions/${session.sessionRef}`)).session;
for (const section of ['topic_sentence', 'supporting_idea_1', 'supporting_idea_2', 'draft']) {
  assert.equal(session.sections[section].status, 'passed');
  assert.equal(session.sections[section].locked, true);
}
emit('all_steps_complete', { sessionRef: session.sessionRef, draftVersion: session.draftVersion });
