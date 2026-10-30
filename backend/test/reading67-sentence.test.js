// Kiểm adapter đúng snapshot CTA; provider giả, không chấm hoặc ghi Docs thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import express from 'express';
import request from 'supertest';
import {loadReading67SentenceGrader} from '../src/reading-listening67/web-sentence-grader.js';
import {sha256} from '../src/reading-listening67/web-grader.js';
import {reading67ResultSummary,reading67ProgressText} from '../src/reading-listening67/web-result-summary.js';
import {createReading67WebStore} from '../src/reading-listening67/web-store.js';
import {createReading67WebRouter} from '../src/reading-listening67/web-routes.js';
const dir=process.env.READING_SENTENCE_PRIVATE_DIR,run=dir?test:test.skip;
async function setup(provider){const snapshotPath=dir+'/grader.live.private.json';return loadReading67SentenceGrader({snapshotPath,expectedSha256:sha256(await fs.readFile(snapshotPath,'utf8')),provider});}
const answers=g=>Object.fromEntries(g.profile.expected_target_ids.map(id=>[id,g.config.targets[id].oracle.canonical||g.config.targets[id].oracle.correct_answer]));
const initial=(g,p)=>({schema_version:g.config.ai_schema_version,lesson_id:g.config.lesson_id,grading_contract_version:g.config.grading_contract_version,results:p.graded.semantic_targets.map(t=>({target_id:t.target_id,verdict:'correct',error_code:null,feedback:null,next_step:null}))});
const envelope=(g,v)=>({gatewayMeta:{model_id:g.pins.model,thinking_level:g.pins.thinking,worker:'fixture',dispatcher_worker:'fixture'},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(v)}]}}]});
async function step(g,p,options={}){try{return {result:await g.finish(p,options)};}catch(error){if(error.code!=='AI_REPAIR_PENDING')throw error;return {state:structuredClone(error.details.state)};}}
run('Đúng CTA, 4 đáp án exact + 24 mục semantic; ngưỡng 23/28, diagnostic không tăng số hoàn thành',async()=>{
 const g=await setup(),a=answers(g),ids=g.profile.expected_target_ids;
 assert.equal(g.pins.workflowId,'5kghTUphTSvJ9RgT');assert.equal(g.config.code,'67-reading-athletes-and-stress');
 assert.equal(g.inspectWeb(Object.fromEntries(Object.entries(a).slice(0,22))).completeness.eligible_for_grading,false);
 assert.equal(g.inspectWeb({...Object.fromEntries(Object.entries(a).slice(0,22)),'l6.sc.q20.polarity.diagnostic':'tiêu cực'}).completeness.eligible_for_grading,false);
 assert.equal(g.inspectWeb(Object.fromEntries(Object.entries(a).slice(0,23))).completeness.eligible_for_grading,true);
 const p=g.prepareWeb(a);assert.equal(p.graded.deterministic_results.length,4);assert(p.graded.deterministic_results.every(r=>r.verdict==='correct'));assert.equal(p.graded.semantic_targets.length,24);assert.equal(ids.length,28);
 assert.throws(()=>g.parseWeb({'l3.H.C':'i'}),{code:'TARGET_UNKNOWN'});assert.throws(()=>g.parseWeb({'l6.sc.q20.polarity.diagnostic':5}),{code:'ANSWER_INVALID'});
 const wrong={...a,'l6.sc.q19.answer':'two words'};assert.equal(g.prepareWeb(wrong).graded.deterministic_results.find(r=>r.target_id==='l6.sc.q19.answer').verdict,'incorrect');
});
run('Thiếu giải thích được bổ sung đúng trường; review ID rồi mới hoàn tất; replay không gọi AI lại',async()=>{
 let calls=0,responses=[];const g=await setup(async()=>{calls++;return envelope(g,responses.shift());}),p=g.prepareWeb(answers(g),'sentence-fixture');
 const v=initial(g,p),id=v.results[0].target_id;v.results[0]={target_id:id,verdict:'partial',error_code:g.config.semantic_error_codes[0],feedback:'',next_step:'Lần sau, hãy nêu đầy đủ ý còn thiếu trong phần phân tích.'};responses.push(v);
 let s=await step(g,p);assert.equal(s.state.phase,'repair');assert.deepEqual(s.state.issues[0].fields,['feedback']);
 responses.push({results:[{target_id:id,feedback:'Em còn thiếu mối liên hệ giữa từ khóa và thông tin được diễn đạt lại.'}]});s=await step(g,p,{validationState:JSON.parse(JSON.stringify(s.state))});assert.equal(s.state.phase,'review');
 responses.push({results:v.results.map(r=>({target_id:r.target_id,accepted:true,fields:[],problems:[]}))});s=await step(g,p,{validationState:s.state});
 assert.equal(s.result.grading.target_results.length,28);const summary=reading67ResultSummary(s.result);assert.equal(summary.matchingTotal,4);assert.equal(summary.analysisTotal,20);assert.equal(summary.paragraphTotal,4);assert.equal(summary.remainingCount,1);assert.equal(summary.allCorrect,false);assert.match(reading67ProgressText(summary),/phân tích từ khóa/);
 assert.equal(calls,3);await g.finish(p,{validationState:JSON.parse(JSON.stringify(s.result.audit.validation))});assert.equal(calls,3);
 const broken=structuredClone(s.result);broken.grading.target_results.pop();assert.equal(reading67ResultSummary(broken),null);
});
run('Không nhận ID lạ, không đổi verdict đã khóa, không nhận checkpoint khác bài',async()=>{
 let values=[];const g=await setup(async()=>envelope(g,values.shift())),p=g.prepareWeb(answers(g)),v=initial(g,p),id=v.results[0].target_id;
 v.results[0]={target_id:id,verdict:'partial',error_code:g.config.semantic_error_codes[0],feedback:'',next_step:'Lần sau, hãy diễn đạt đủ thông tin cần thiết.'};values.push(v);let s=await step(g,p);
 values.push({results:[{target_id:id,verdict:'correct',feedback:'Em còn thiếu ý quan trọng để xác định đúng thông tin.'}]});s=await step(g,p,{validationState:s.state});assert.equal(s.state.value.results[0].verdict,'partial');assert.equal(s.state.lastRepairError.message,'AI_REPAIR_LOCKED_FIELD');
 const other=initial(g,p);other.results[0].target_id='foreign-target';await assert.rejects(()=>g.finish(p,{replayResponse:envelope(g,other)}),{code:'AI_IDENTITY_MISMATCH'});await assert.rejects(()=>g.finish(p,{validationState:{...s.state,inputFingerprint:'other'}}),{code:'VALIDATION_INPUT_MISMATCH'});
});
run('Lưu/nộp/nháp đúng chủ; cờ 19–22 hợp lệ; diagnostic được giữ mà không chấm; bài cũ không đổi',async t=>{
 const db=new PGlite();t.after(()=>db.close());
 for(const [date,name] of [['2026-10-22','web'],['2026-10-26','validation']])await db.exec(await fs.readFile(new URL(`../../docs/migrations/${date}-reading67-${name}.sql`,import.meta.url),'utf8'));
 const g=await setup(),content=JSON.parse(await fs.readFile(dir+'/content.private.json','utf8')),store=createReading67WebStore({db,grader:g,jobScope:{code:content.code,version:content.version}});
 const a={ownerId:randomUUID(),courseId:'synthetic-course',code:content.code,version:content.version},b={...a,ownerId:randomUUID()};
 const app=express();app.use(express.json());app.use(createReading67WebRouter({store,content,grader:g,authenticate:async()=>a,config:{studentsOpen:true}}));
 const body={answers:{...answers(g),'l6.sc.q20.polarity.diagnostic':'tiêu cực'},annotations:[],notes:'Giữ ghi chú',flags:[19,22]};
 const saved=await request(app).put('/draft').send({baseRevision:0,mutationId:randomUUID(),body});assert.equal(saved.status,200);
 assert.equal((await request(app).put('/draft').send({baseRevision:saved.body.revision,mutationId:randomUUID(),body:{...body,flags:[1]}})).status,400);
 const sent=await store.submit(a,{revision:saved.body.revision,requestId:randomUUID()});assert.equal(sent.snapshot.answers['l6.sc.q20.polarity.diagnostic'],'tiêu cực');assert.deepEqual(sent.snapshot.flags,[19,22]);assert.equal(sent.completeness.expected_cells,28);
 await assert.rejects(()=>store.attempt(b,sent.attemptId),{code:'ATTEMPT_NOT_FOUND'});assert.deepEqual((await store.draft(b)).body.answers,{});
});
