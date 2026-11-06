import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeReadingStop,verifyReadingPractice} from '../src/reading-listening67/web-share-practice.js';

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
