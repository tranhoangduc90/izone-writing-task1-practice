import test from 'node:test';
import assert from 'node:assert/strict';
import {createReading67CtaDispatcher} from '../src/reading-listening67/web-homework-cta.js';
test('Chọn đúng bài trước ghi; thiếu mã bỏ qua, nhiều bài/sai Docs dừng trước ghi',async()=>{
 const calls=[],event={doc_id:'test-doc'},codes=['legacy-materials','new-tfng'];
 let body='',documentId=event.doc_id;
 const docs={read:async()=>({documentId,tabs:[{documentTab:{body:{content:[{paragraph:{elements:[{textRun:{content:body}}]}}]}}}]})};
 const run=createReading67CtaDispatcher({docs,registrars:codes.map(code=>({code,registerCta:async e=>{calls.push([code,e.doc_id]);return {status:'verified',assignmentCode:code};}}))});
 for(const code of codes){body=code;assert.equal((await run(event)).assignmentCode,code);}
 assert.deepEqual(calls,codes.map(code=>[code,event.doc_id]));
 body='different';assert.equal((await run(event)).status,'not_applicable');
 body=codes.join('\n');await assert.rejects(run(event),e=>e.code==='DOC_CODE_MISMATCH');
 documentId='wrong-doc';await assert.rejects(run(event),e=>e.code==='DOC_IDENTITY_MISMATCH');
 assert.equal(calls.length,2);
});
