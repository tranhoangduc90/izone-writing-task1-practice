import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyK67FinalProof } from '../src/reading-listening67/classroom-cta-stack.js';

const docId = 'fixture_document_123456789012345', classCode = 'IC2353';
const pages = 'https://tranhoangduc90.github.io/izone-ai-team-pages/';
const readingCode = '67-practice-reading_fixture';
const listeningCode = '67-practice-listening_fixture';
const exact = pages + 'speaking-homework/?documentId=' + docId;
const rawReading = pages + 'reading-practice/?documentId=' + docId + '&assignmentCode=' + readingCode + '#demo?entry=fake';
const rawListening = pages + 'listening-practice/?documentId=' + docId + '&assignmentCode=' + listeningCode + '#demo?entry=fake';

test('đọc lại link native, kể cả Reading cũ thiếu URL trong ACK và Listening thêm query', async () => {
  const context = { source: { documentId: docId, classroom: { classCode } }, nativeReceipts: new Map([
    ['reading_practice', { code: readingCode }],
    ['listening_practice', { code: listeningCode, entryUrl: rawListening.replace('#', '&class=IC2353&mode=student#') }],
    ['speaking', { entryUrl: exact }],
  ]) };
  let urls = [rawReading, rawListening, exact];
  const verify = verifyK67FinalProof({ async read() {
    return { documentId: docId, revisionId: 'fixture-r1',
      body: urls.map(url => ({ textRun: { textStyle: { link: { url } } } })) };
  } });
  const proof = [...context.nativeReceipts.keys()].map(product => ({ product, status: 'verified' }));
  assert.deepEqual(await verify(context, proof), []);
  urls = [rawReading.replace(docId, 'wrong_document'), rawListening.replace('#', '&class=IC2340#')];
  assert.deepEqual(await verify(context, proof), ['reading_practice', 'listening_practice', 'speaking']);
});
