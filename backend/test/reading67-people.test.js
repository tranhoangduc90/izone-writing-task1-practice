// Snapshot và key thật nằm trong kho private; suite dùng AI giả và SQL cục bộ.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import {loadReading67PeopleGrader} from '../src/reading-listening67/web-people-grader.js';
import {sha256,WebGradingError} from '../src/reading-listening67/web-grader.js';
import {reading67ResultSummary} from '../src/reading-listening67/web-result-summary.js';
import {createReading67WebStore} from '../src/reading-listening67/web-store.js';
import {createReading67WebRouter} from '../src/reading-listening67/web-routes.js';
const dir=process.env.PEOPLE_PRIVATE_DIR,run=dir?test:test.skip;
async function setup(provider){
 const snapshotPath=path.join(dir,'grader.live.private.json'),auditPath=path.join(dir,'audit.private.json');
 const grader=await loadReading67PeopleGrader({snapshotPath,expectedSha256:sha256(await fs.readFile(snapshotPath,'utf8')),auditPath,auditSha256:sha256(await fs.readFile(auditPath,'utf8')),provider});
 return {grader,answers:Object.fromEntries(grader.config.targets.map(t=>[t.id,t.modelAnswer]))};
}
const response=(grader,value)=>({gatewayMeta:{model_id:grader.pins.model,thinking_level:grader.pins.thinking,worker:'fixture',dispatcher_worker:'fixture'},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
function audit(p,{partial=false}={}){const profile=p.graded.stability_decision_profile;return {schema_version:profile.ai_schema_version,lesson_id:profile.lesson_id,prompt_version:profile.prompt_version,oracle_version:profile.oracle_version,results:p.graded.semantic_targets.map((t,index)=>({target_id:t.target_id,unit_audit:profile.structured_oracles[t.target_id].core_units.map((u,i)=>({unit_id:u.id,status:partial&&index===0&&i===0?'absent':'present',student_span:partial&&index===0&&i===0?null:t.student_response})),relation_status:profile.structured_oracles[t.target_id].required_relation.applicable?'correct':'not_applicable',economy_status:profile.structured_oracles[t.target_id].economy_applicable?'adequate':'not_applicable',critical_failure:null,primary_issue_unit_id:null,proposed_error_code:null,why_student_wrong:partial&&index===0?'Em còn thiếu một ý cần thiết trong phần nén này.':''})).reverse()};}
const reviews=p=>({results:p.graded.semantic_targets.map(t=>({target_id:t.target_id,accepted:true,scope:'feedback',fields:[],problems:[]}))});
async function pending(fn){try{await fn();assert.fail('Phải yêu cầu bổ sung');}catch(e){assert.equal(e.code,'AI_REPAIR_PENDING',e.stack);return e.details.state;}}
run('Đúng25 ô/ngưỡng20, placeholder và ID lạ; giữ key và hai phát biểu A củaCTA',async()=>{
 const {grader:g,answers}=await setup();assert.equal(g.profile.expected_cells,25);assert.equal(g.config.targets.filter(t=>t.person==='A').length,6);
 for(const n of [19,20,25])assert.equal(g.inspectWeb(Object.fromEntries(Object.entries(answers).slice(0,n))).completeness.eligible_for_grading,n>=20);
 assert.equal(g.inspectWeb({'q9.compressed_level_1':'...'}).completeness.filled_cells,0);
 assert.throws(()=>g.parseWeb({...answers,foreign:'x'}),e=>e.code==='ANSWERS_INVALID');
 const p=g.prepareWeb(answers);assert.equal(Object.keys(p.fixed).length,15);assert.ok(Object.values(p.fixed).every(d=>d.verdict==='correct'));assert.equal(p.graded.semantic_targets.length,10);
 assert.equal(g.prepareWeb({...answers,'q10.answer':'A','q13.answer':'A'}).fixed['q10.answer'].verdict,'correct');
 assert.equal(g.prepareWeb({...answers,'q9.answer':'A'}).fixed['q9.answer'].verdict,'incorrect');
});
run('Audit đảo thứ tự vẫn gắn đúng25 mục; complete replay không gọiAI; summary thiếu không đạt',async()=>{
 let value,calls=0;const {grader:g,answers}=await setup(async()=>{calls++;return response(g,value);});
 const p=g.prepareWeb(answers,'same-operation');value=audit(p);const s=await pending(()=>g.finish(p));assert.equal(s.phase,'review');
 value=reviews(p);let complete;const result=await g.finish(p,{validationState:s,onCheckpoint:v=>complete=structuredClone(v)});
 assert.equal(calls,2);assert.equal(reading67ResultSummary(result).allCorrect,true);assert.equal(reading67ResultSummary(result).matchingTotal,15);assert.equal(reading67ResultSummary(result).compressionTotal,10);
 await g.finish(p,{validationState:complete});assert.equal(calls,2);
 const broken=structuredClone(result);broken.grading.target_results.pop();assert.equal(reading67ResultSummary(broken),null);
 await assert.rejects(()=>g.finish(g.prepareWeb({...answers,'q9.answer':'A'},'same-operation'),{validationState:complete}),e=>e.code==='VALIDATION_INPUT_MISMATCH');
});
run('Ô chọn sai cũng cầnAI giải thích/hướng sửa; không thay kết luận củaCTA',async()=>{
 let value;const {grader:g,answers}=await setup(async()=>response(g,value));const p=g.prepareWeb({...answers,'q9.answer':'A'});value=audit(p);
 let s=await pending(()=>g.finish(p));assert.equal(s.phase,'repair');assert.ok(s.issues.some(i=>i.targetId==='q9.answer'));
 value={results:[{target_id:'q9.answer',why_student_wrong:'Em đang nhầm người phát biểu về lợi ích môi trường của vật liệu thay thế.',next_step:'Lần sau, hãy tìm đúng người đưa ra điều kiện ảnh hưởng đến lợi ích môi trường.'}]};
 s=await pending(()=>g.finish(p,{validationState:s}));assert.equal(s.phase,'review');value=reviews(p);const result=await g.finish(p,{validationState:s});
 assert.equal(result.feedback['q9.answer'].status,'incorrect');assert.equal(reading67ResultSummary(result).remainingCount,1);assert.ok(result.feedback['q9.answer'].nextStep);
});
run('Thiếu ý/hướng sửa, dẫn chứng bịa, target lạ,429 và timeout chưa rõ',async()=>{
 let value;const {grader:g,answers}=await setup(async()=>response(g,value));const p=g.prepareWeb(answers);value=audit(p,{partial:true});let s=await pending(()=>g.finish(p));assert.equal(s.phase,'repair');assert.ok(s.issues.some(i=>i.field==='next_step'));
 value=audit(p);value.results[0].unit_audit[0].student_span='Chuỗi hoàn toàn không có trong bài làm';s=await pending(()=>g.finish(p));assert.ok(s.issues.some(i=>i.code==='AI_EVIDENCE_INVALID'));
 value=audit(p);value.results[0].target_id='foreign';await assert.rejects(()=>g.finish(p),e=>e.code==='AI_IDENTITY_MISMATCH');
 const retry=await setup(async()=>{throw new WebGradingError('AI_HTTP_429',503);});s=await pending(()=>retry.grader.finish(retry.grader.prepareWeb(retry.answers)));assert.equal(s.serviceError.code,'AI_HTTP_429');
 const unknown=await setup(async()=>{throw new WebGradingError('AI_OUTCOME_UNKNOWN',503);});await assert.rejects(()=>unknown.grader.finish(unknown.grader.prepareWeb(unknown.answers)),e=>e.code==='AI_OUTCOME_UNKNOWN');
});
run('SQL/HTTP thật: cờ9–13, CAS, cách ly owner/lớp/bài, không claim việc bài khác',async t=>{
 const {grader:g,answers}=await setup(),db=new PGlite();t.after(()=>db.close());
 for(const [date,name] of [['2026-10-22','web'],['2026-10-26','validation']])await db.exec(await fs.readFile(new URL('../../docs/migrations/'+date+'-reading67-'+name+'.sql',import.meta.url),'utf8'));
 const scope={ownerId:'11111111-1111-4111-8111-111111111111',courseId:'-90008',code:g.config.code,version:g.config.version};
 const store=createReading67WebStore({db,grader:g,jobScope:{code:scope.code,version:scope.version}}),content=JSON.parse(await fs.readFile(path.join(dir,'content.private.json'),'utf8'));
 const app=express();app.use('/api',createReading67WebRouter({store,grader:g,content,authenticate:async()=>scope}));
 const body={answers,flags:[9,13],annotations:[],notes:'Nháp cách ly'};
 const saved=(await request(app).put('/api/draft').send({baseRevision:0,mutationId:randomUUID(),body}).expect(200)).body;
 assert.equal(saved.revision,1);await request(app).put('/api/draft').send({baseRevision:1,mutationId:randomUUID(),body:{...body,flags:[1]}}).expect(400);
 await request(app).put('/api/draft').send({baseRevision:0,mutationId:randomUUID(),body}).expect(409);
 assert.equal((await store.draft({...scope,courseId:'-90009'})).revision,0);
 const submitted=await store.submit(scope,{revision:1,requestId:randomUUID()});
 const other=createReading67WebStore({db,grader:g,jobScope:{code:'other',version:scope.version}});assert.equal(await other.claim(),null);
 assert.equal((await store.claim()).jobId,submitted.jobId);assert.deepEqual((await store.draft(scope)).body.answers,answers);
});
