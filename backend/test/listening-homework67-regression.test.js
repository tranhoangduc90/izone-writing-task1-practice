import test from 'node:test';
import assert from 'node:assert/strict';
import {createListeningGrader} from '../src/listening-homework67/grader.js';
const lesson={version:'fixture-v2',minimumCompletion:1,items:[{id:'Q',answer:'approved',core:'Two independent ideas; keep correct speaker attribution.',units:[{id:'Q.1',meaning:'First idea'},{id:'Q.2',meaning:'Evidence'}]}]};
const row=(raw)=>({target_id:'Q',units:lesson.items[0].units.map(u=>({unit_id:u.id,status:'present',span:raw})),writing_notes:[],contradiction:false,meaning_errors:[],reason:'Đã thể hiện đủ các ý được yêu cầu.',next_step:''});
async function finish(g,p){let state;for(let n=0;n<12;n++)try{return await g.finish(p,{validationState:state,onCheckpoint:async s=>{state=structuredClone(s);}});}catch(e){if(e.code!=='AI_REPAIR_PENDING')throw e;}throw Error('incomplete');}
test('Invisible formatting and dash placeholders never unlock grading; original input survives',()=>{
 const g=createListeningGrader({lesson});for(const raw of ['\u200b','\u2060','—','–',' - — … ','\u200b…']){const v=g.inspectWeb({Q:raw});assert.equal(v.completeness.answered,0,JSON.stringify(raw));assert.equal(v.parsed.targets[0].source_text_original,raw);}
 assert.equal(g.inspectWeb({Q:'social\u200b context'}).completeness.answered,1);
});
test('Independent review cannot approve a speaker conflict as a writing-only note',async()=>{
 let calls=0;const raw='correct idea with a false attribution';
 const g=createListeningGrader({lesson,maxRounds:4,provider:async({prompt})=>{
  calls++;if(prompt.includes('lượt kiểm nội dung độc lập'))return {reviews:[{target_id:'Q',accepted:true,problems:[],expected_verdict:'incorrect',expected_met_units:2,meaning_errors:[{kind:'speaker',span:'false attribution',explanation:'Gán nội dung cho sai người nói.'}]}]};
  const r=row(raw);r.writing_notes=['Lỗi nhỏ về người nói, vẫn chấp nhận.'];return {results:[r]};
 }});
 await assert.rejects(finish(g,g.prepareWeb({Q:raw})),e=>e.code==='AI_VALIDATION_NEEDS_REVIEW');assert.ok(calls>=2);
});
test('Unsupported quotation alone cannot turn one met idea into a contradictory whole answer',async()=>{
 const raw='Yes; unrelated quotation';let audits=0;
 const g=createListeningGrader({lesson,provider:async({prompt})=>{
  if(prompt.includes('lượt kiểm nội dung độc lập'))return {reviews:[{target_id:'Q',accepted:true,problems:[],expected_verdict:'partial',expected_met_units:1,meaning_errors:[]}]};
  audits++;const r=row(raw);r.units[1]={unit_id:'Q.2',status:audits===1?'contradicted':'absent',span:audits===1?'unrelated quotation':null};r.reason='Nhận định đúng, dẫn chứng chưa hỗ trợ ý cần chứng minh.';r.next_step='Lần sau, chọn dẫn chứng hỗ trợ đúng nhận định.';return {results:[r]};
 }});
 const out=await finish(g,g.prepareWeb({Q:raw}));assert.equal(out.feedback.Q.status,'partial');assert.equal(out.feedback.Q.metUnits,1);assert.equal(out.feedback.Q.totalUnits,2);
});

test('A complete job keeps four-target batches and all IDs, including recovery after one malformed review',async()=>{
 const many={...lesson,items:Array.from({length:22},(_,n)=>({id:'Q'+n,answer:'approved '+n,core:'Fixture meaning',units:[{id:'Q'+n+'.1',meaning:'Required idea'}]}))},calls=[];
 let failedOnce=false;const checkpoints=[];
 const provider=async({prompt})=>{const payload=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1)),reviewing=prompt.includes('lượt kiểm nội dung độc lập');calls.push({reviewing,ids:payload.targets.map(i=>i.id)});
  if(reviewing&&!failedOnce){failedOnce=true;return {reviews:[]};}
  return reviewing?{reviews:payload.targets.map(i=>({target_id:i.id,accepted:true,problems:[],expected_verdict:'correct',expected_met_units:1,meaning_errors:[]})).reverse()}:{results:payload.targets.map(i=>({target_id:i.id,units:[{unit_id:i.units[0].id,status:'present',span:i.response}],contradiction:false,meaning_errors:[],writing_notes:[],reason:'Fixture thể hiện đúng ý được yêu cầu.',next_step:''})).reverse()};};
 const g=createListeningGrader({lesson:many,provider});let state,result;
 const prepared=g.prepareWeb(Object.fromEntries(many.items.map(i=>[i.id,'variant '+i.id])));
 for(let n=0;n<18;n++)try{result=await g.finish(prepared,{validationState:state,onCheckpoint:async s=>{state=structuredClone(s);checkpoints.push(state.stalledRounds??0);}});break;}catch(e){if(e.code!=='AI_REPAIR_PENDING')throw e;}
 assert.equal(result.grading.summary.correctCount,22);assert.ok(calls.every(c=>c.ids.length<=4),'Model requests must contain at most four targets');
 assert.equal(calls.length,13);assert.equal(Math.max(...checkpoints),1);assert.equal(checkpoints.at(-1),0);
 for(const phase of [true,false])assert.equal(new Set(calls.filter(c=>c.reviewing===phase).flatMap(c=>c.ids)).size,22);
});
