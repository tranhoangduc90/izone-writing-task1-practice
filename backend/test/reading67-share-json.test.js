import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {analyzeReadingStop,verifyReadingPractice} from '../src/reading-listening67/web-share-practice.js';
import {readSpeakingShare} from '../src/reading-listening67/vendor/speaking-share-reader.js';

test('Reading Share reads an Octane transcript with a pending empty final assistant frame', async t => {
 const share = 'https://chatgpt.com/share/11111111-1111-4111-8111-111111111111';
 const question = 'Nén câu này.';
 const feedback = 'Hãy giữ đúng ý chính.';
 const rows = [
  {frame: {id: '1', role: 'user', text: question}},
  {frame: {id: '2', role: 'assistant'}, source: {markdown: '', dil: {fallbackMarkdown: feedback}}},
  {frame: {id: '3', role: 'user', text: 'Tôi thử lại.'}},
 ];
 const pending = {frame: {id: '4', role: 'assistant'}, source: {markdown: '', dil: {kind: 'dil', status: 'pending', fallbackMarkdown: ''}}};
 let activeRows = [...rows, pending];
 const direct = t.mock.method(https, 'get', (url, options, callback) => {
  const html = `<!doctype html><script id="octane-conversation-transcript">${JSON.stringify({rows: activeRows})}</script>`;
  const response = Readable.from([Buffer.from(html)]);
  Object.assign(response, {statusCode: 200, headers: {}});
  callback(response);
  return new EventEmitter();
 });
 const fallback = t.mock.method(globalThis, 'fetch', async () => new Response('{}'));
 const read = await readSpeakingShare(share);
 assert.equal(read.source, 'direct');
 assert.deepEqual(read.messages.map(({id, text}) => [id, text]), [['1', question], ['2', feedback], ['3', 'Tôi thử lại.']]);
 assert.equal(direct.mock.callCount(), 1);
 assert.equal(fallback.mock.callCount(), 0);

 for (const invalidRows of [
  [...rows, {...pending, source: {markdown: '', dil: {...pending.source.dil, status: 'complete'}}}],
  [...rows.slice(0, 2), pending, rows[2]],
  [...rows, {...pending, frame: {role: 'assistant'}}],
  [...rows, {...pending, frame: {...pending.frame, id: '2'}}],
  [rows[0], pending],
 ]) {
  activeRows = invalidRows;
  await assert.rejects(() => readSpeakingShare(share), {shareReadReason: 'OCTANE_MESSAGE_INVALID'});
 }
});

// Existing stopping-rule tests only supplied plain JSON. Real providers may wrap JSON
// in Markdown; this must neither quarantine an unfinished practice nor bypass evidence.
const messages=[{role:'user',text:'Tôi thử nén lại.'},{role:'assistant',text:'Hôm nay chúng ta tạm nghỉ để tránh quá tải.'}];
const target='Reading nén cấp 1';
const value={stopped:true,matched:true,confidence:.99,reason:'mercy_rule',candidateId:'m1'};
const call=raw=>async()=>new Response(JSON.stringify({candidates:[{content:{parts:[{thought:true,text:'ignore this'},{text:raw}]}}]}));
for(const fenced of [false,true]){
 const encode=v=>fenced?'\n```json\n'+JSON.stringify(v)+'\n```\n':JSON.stringify(v);
 test(`Reading Share ${fenced?'fenced':'plain'} JSON: unfinished remains rejected and valid stop retains evidence`,async()=>{
  const stop=(m,t)=>analyzeReadingStop(m,t,call(encode({...value,stopped:false})));
  const result=await verifyReadingPractice({messages},target,async()=>({completed:false,confidence:.99}),stop);
  assert.equal(result.status,'rejected');assert.equal(result.evidence,null);
  assert.match(result.message,/tiếp tục luyện/);
  const accepted=await analyzeReadingStop(messages,target,call(encode(value)));
  assert.equal(accepted.quote,messages[1].text);assert.equal(accepted.reason,'mercy_rule');
  for(const invalid of [{...value,candidateId:'m99'},{...value,matched:false},{...value,confidence:.2}]){
   await assert.rejects(()=>analyzeReadingStop(messages,target,call(encode(invalid))),{code:'SHARE_EVIDENCE_INVALID'});
  }
 });
}
test('Reading Share malformed or empty JSON is an explicit analysis failure, never accepted',async()=>{
 for(const raw of ['', '```json\n{"stopped":', 'null', '[]']){
  await assert.rejects(()=>analyzeReadingStop(messages,target,call(raw)),{code:'SHARE_RESULT_INVALID'});
 }
});
