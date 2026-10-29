// Snapshot/rubric thật ở kho private; AI trong suite là fixture, không gọi provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {loadGreenRoofsGrader} from '../src/reading-listening67/web-green-roofs-grader.js';
import {sha256,WebGradingError} from '../src/reading-listening67/web-grader.js';
import {reading67ResultSummary} from '../src/reading-listening67/web-result-summary.js';
import {createReading67WebStore} from '../src/reading-listening67/web-store.js';
const dir=process.env.GREEN_ROOFS_PRIVATE_DIR,run=dir?test:test.skip;
async function setup(provider){
 const snapshotPath=path.join(dir,'grader.live.private.json'),auditPath=path.join(dir,'audit.private.json');
 const grader=await loadGreenRoofsGrader({snapshotPath,expectedSha256:sha256(await fs.readFile(snapshotPath,'utf8')),auditPath,auditSha256:sha256(await fs.readFile(auditPath,'utf8')),provider});
 const answers=Object.fromEntries(grader.profile.expected_target_ids.map(id=>[id,'Bản nén giả dùng kiểm hợp đồng, không là đáp án học viên.']));
 for(const group of grader.config.sourceConfig.deterministic_groups)group.target_ids.forEach((id,i)=>answers[id]=group.oracle_multiset[i]);
 return {grader,answers};
}
const response=(grader,value)=>({gatewayMeta:{model_id:grader.pins.model,thinking_level:grader.pins.thinking,worker:'fixture',dispatcher_worker:'fixture'},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
function audit(prepared,{partial=false,empty=false}={}){const p=prepared.graded.stability_decision_profile;return {schema_version:p.ai_schema_version,lesson_id:p.lesson_id,prompt_version:p.prompt_version,oracle_version:p.oracle_version,results:prepared.graded.semantic_targets.map((t,index)=>({target_id:t.target_id,unit_audit:p.structured_oracles[t.target_id].core_units.map((u,i)=>({unit_id:u.id,status:partial&&index===0&&i===0?'absent':'present',student_span:partial&&index===0&&i===0?null:t.student_response})),relation_status:p.structured_oracles[t.target_id].required_relation.applicable?'correct':'not_applicable',economy_status:p.structured_oracles[t.target_id].economy_applicable?'adequate':'not_applicable',critical_failure:null,primary_issue_unit_id:null,proposed_error_code:null,why_student_wrong:partial&&index===0&&!empty?'Em còn thiếu một ý cần thiết trong nội dung nén đoạn này.':''})).reverse()};}
const reviews=prepared=>({results:prepared.graded.semantic_targets.map(t=>({target_id:t.target_id,accepted:true,scope:'feedback',fields:[],problems:[]}))});
async function pending(fn){try{await fn();assert.fail('Phải tiếp tục bổ sung');}catch(e){assert.equal(e.code,'AI_REPAIR_PENDING');return e.details.state;}}
run('Mã theo tiêu đề, đủ14 mục, ngưỡng12; bỏ trống/placeholder không tính đã làm',async()=>{
 const {grader,answers}=await setup();assert.equal(grader.config.code,'67-reading-green-roofs');assert.equal(grader.profile.expected_cells,14);
 assert.equal(grader.inspectWeb(answers).completeness.filled_cells,14);
 for(const n of [11,12]){const partial=Object.fromEntries(Object.entries(answers).slice(0,n));assert.equal(grader.inspectWeb(partial).completeness.eligible_for_grading,n>=12);}
 assert.equal(grader.inspectWeb({'l4.paragraph.a.level_1':'...'}).completeness.filled_cells,0);
 assert.throws(()=>grader.parseWeb({...answers,'foreign-id':'value'}),e=>e.code==='ANSWERS_INVALID');
 assert.throws(()=>grader.parseWeb({...answers,'l4.mcq.q10.answer':'F'}),e=>e.code==='ANSWER_INVALID');
});
run('Đúng logic CTA: hai đáp án đảo thứ tự vẫn đúng; lặp một đáp án chỉ tính một lần',async()=>{
 const {grader,answers}=await setup();
 for(const group of grader.config.sourceConfig.deterministic_groups){const reversed={...answers};group.target_ids.forEach((id,i)=>reversed[id]=group.oracle_multiset[1-i]);assert.equal(grader.prepareWeb(reversed).exact.deterministic_results.filter(r=>r.verdict==='correct').length,4);const duplicate={...answers};group.target_ids.forEach(id=>duplicate[id]=group.oracle_multiset[0]);assert.equal(grader.prepareWeb(duplicate).exact.deterministic_results.filter(r=>r.verdict==='incorrect').length,1);}
});
run('Đảo thứ tự audit vẫn gắn đúng14 mục; checkpoint đã hoàn tất không gọiAI lại',async()=>{
 let value,calls=0;const {grader,answers}=await setup(async()=>{calls++;return response(grader,value);});
 const prepared=grader.prepareWeb(answers,'operation-A');value=audit(prepared);const state=await pending(()=>grader.finish(prepared));assert.equal(state.phase,'review');
 value=reviews(prepared);let complete;const result=await grader.finish(prepared,{validationState:state,onCheckpoint:s=>{complete=structuredClone(s);}});
 assert.equal(calls,2);assert.equal(result.grading.target_results.length,14);assert.equal(reading67ResultSummary(result).allCorrect,true);assert.equal(reading67ResultSummary(result).compressionTotal,10);
 await grader.finish(prepared,{validationState:complete});assert.equal(calls,2);
 const bad=structuredClone(result);bad.grading.target_results.pop();assert.equal(reading67ResultSummary(bad),null);
 await assert.rejects(()=>grader.finish(grader.prepareWeb({...answers,'l4.paragraph.a.level_1':'Bản khác'},'operation-A'),{validationState:complete}),e=>e.code==='VALIDATION_INPUT_MISMATCH');
});
run('Thiếu giải thích/hướng sửa tiếp tục bổ sung; giữ nguyên verdict do luật tính',async()=>{
 let value;const {grader,answers}=await setup(async()=>response(grader,value));const prepared=grader.prepareWeb(answers);value=audit(prepared,{partial:true,empty:true});
 let state=await pending(()=>grader.finish(prepared));assert.equal(state.phase,'repair');assert.ok(state.issues.some(i=>i.field==='why_student_wrong'));assert.ok(state.issues.some(i=>i.field==='next_step'));
 value={results:[]};for(let i=0;i<4;i++)state=await pending(()=>grader.finish(prepared,{validationState:state}));assert.equal(state.phase,'repair');
 const id=prepared.graded.semantic_targets[0].target_id;value={results:[{target_id:id,why_student_wrong:'Em còn thiếu ý điều kiện hỗ trợ cần thiết trong phần nén này.',next_step:'Lần sau, hãy đọc lại đoạn và bổ sung điều kiện giúp việc triển khai thành công.'}]};
 state=await pending(()=>grader.finish(prepared,{validationState:state}));assert.equal(state.phase,'review');value=reviews(prepared);const result=await grader.finish(prepared,{validationState:state});assert.equal(result.feedback[id].status,'partial');assert.match(result.feedback[id].nextStep,/^Lần sau,/);assert.equal(reading67ResultSummary(result).remainingCount,1);
});
run('Dẫn chứng ngoài bài làm và target lạ bị chặn; 429 giữ scope; timeout chưa rõ không báo hoàn tất',async()=>{
 let value;const {grader,answers}=await setup(async()=>response(grader,value));const prepared=grader.prepareWeb(answers);value=audit(prepared);value.results[0].unit_audit[0].student_span='A quote absent from learner answer';let state=await pending(()=>grader.finish(prepared));assert.ok(state.issues.some(i=>i.code==='AI_EVIDENCE_INVALID'));
 value=audit(prepared);value.results[0].target_id='foreign-target';await assert.rejects(()=>grader.finish(prepared),e=>e.code==='AI_IDENTITY_MISMATCH');
 const retry=await setup(async()=>{throw new WebGradingError('AI_HTTP_429',503);});state=await pending(()=>retry.grader.finish(retry.grader.prepareWeb(retry.answers)));assert.equal(state.serviceError.code,'AI_HTTP_429');
 const unknown=await setup(async()=>{throw new WebGradingError('AI_OUTCOME_UNKNOWN',503);});await assert.rejects(()=>unknown.grader.finish(unknown.grader.prepareWeb(unknown.answers)),e=>e.code==='AI_OUTCOME_UNKNOWN');
});
run('SQL thật: đúng người/lớp/version; claim chỉ lấy việc củaGreen roofs, giữ bài khác',async t=>{
 const {grader,answers}=await setup(),db=new PGlite();t.after(()=>db.close());
 for(const name of ['web','validation'])await db.exec(await fs.readFile(new URL('../../docs/migrations/'+(name==='web'?'2026-10-22':'2026-10-26')+'-reading67-'+name+'.sql',import.meta.url),'utf8'));
 const scope={ownerId:'11111111-1111-4111-8111-111111111111',courseId:'-90004',code:grader.config.code,version:grader.config.version};
 const store=createReading67WebStore({db,grader,jobScope:{code:scope.code,version:scope.version}}),body={answers,flags:[10,13],annotations:[],notes:''};
 const saved=await store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});assert.equal((await store.draft({...scope,courseId:'-90005'})).revision,0);
 const other=createReading67WebStore({db,grader,jobScope:{code:'other-lesson',version:scope.version}});assert.equal(await other.claim(),null);
 const job=await store.submit(scope,{revision:saved.revision,requestId:randomUUID()});const claim=await store.claim();assert.equal(claim.attemptId,job.attemptId);assert.deepEqual(claim.answers,answers);
 await assert.rejects(()=>store.attempt({...scope,ownerId:'22222222-2222-4222-8222-222222222222'},job.attemptId),e=>e.code==='ATTEMPT_NOT_FOUND');
});
