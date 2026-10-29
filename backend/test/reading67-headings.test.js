import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {loadReading67HeadingsGrader} from '../src/reading-listening67/web-headings-grader.js';
import {sha256} from '../src/reading-listening67/web-grader.js';
import {createReadingSharePractice,normalizeReadingShare,verifyReadingPractice,analyzeReadingStop} from '../src/reading-listening67/web-share-practice.js';
import {createReading67WebStore} from '../src/reading-listening67/web-store.js';
import {reading67HeadingsSummary} from '../src/reading-listening67/web-result-summary.js';
const snapshotPath=process.env.READING_HEADINGS_SNAPSHOT;
const sourceTest=snapshotPath?test:test.skip;
const snapshotHash=snapshotPath?sha256(await fs.readFile(snapshotPath,'utf8')):'';
const envelope=value=>({gatewayMeta:{model_id:'gemini-3.6-flash',thinking_level:'medium',worker:'fixture',dispatcher_worker:'fixture'},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
async function grader(provider){return loadReading67HeadingsGrader({snapshotPath,expectedSha256:snapshotHash,provider});}
function answers(g,n=15){return Object.fromEntries(g.profile.expected_target_ids.slice(0,n).map(id=>[id,g.config.targets[id].oracle.canonical||'Tôi tự nén ý chính của đoạn này.']));}
function ai(g,prepared){return {schema_version:g.config.ai_schema_version,lesson_id:g.config.lesson_id,grading_contract_version:g.config.grading_contract_version,results:prepared.graded.semantic_targets.map(t=>({target_id:t.target_id,verdict:'correct',error_code:null,feedback:null,next_step:null}))};}
const checkpoint=async fn=>{try{return {result:await fn()};}catch(error){if(error.code!=='AI_REPAIR_PENDING')throw error;return {state:JSON.parse(JSON.stringify(error.details.state))};}};
sourceTest('Dùng key/target và ngưỡng 12/15 từ snapshot CTA thật',async()=>{
 const g=await grader();assert.equal(g.inspectWeb(answers(g,11)).completeness.eligible_for_grading,false);assert.equal(g.inspectWeb(answers(g,12)).completeness.eligible_for_grading,true);
 assert.throws(()=>g.parseWeb({'unknown':'x'}),{code:'TARGET_UNKNOWN'});
 const prepared=g.prepareWeb(answers(g));const deterministic=prepared.graded.deterministic_results;
 assert.equal(deterministic.length,5);assert(deterministic.every(r=>r.verdict==='correct'));
 assert.equal(prepared.graded.semantic_targets.length,10);
});
sourceTest('Thiếu nhận xét → bổ sung đúng trường → kiểm nội dung → hoàn tất; JSONB không gọi lại',async()=>{
 let calls=0,responses=[];const g=await grader(async()=>{calls++;return envelope(responses.shift());});const prepared=g.prepareWeb(answers(g),'operation');const value=ai(g,prepared),id=value.results[0].target_id;
 value.results[0]={target_id:id,verdict:'partial',error_code:'T-ABS',feedback:'',next_step:'Lần sau, hãy giữ đủ ý chính và quan hệ của đoạn.'};
 responses.push(value);let next=await checkpoint(()=>g.finish(prepared));assert.equal(next.state.phase,'repair');assert.deepEqual(next.state.issues[0].fields,['feedback']);
 responses.push({results:[{target_id:id,feedback:'Em còn thiếu ý cốt lõi giúp giải thích đặc điểm của thiết bị.'}]});next=await checkpoint(()=>g.finish(prepared,{validationState:next.state}));assert.equal(next.state.phase,'review');
 responses.push({results:value.results.map(r=>({target_id:r.target_id,accepted:true,fields:[],problems:[]}))});next=await checkpoint(()=>g.finish(prepared,{validationState:next.state,onCheckpoint:async state=>{next={state:JSON.parse(JSON.stringify(state))};}}));
 assert.equal(next.result.grading.target_results.length,15);assert.equal(next.result.feedback[id].status,'partial');assert.equal(calls,3);
 const completeState=next.result.audit.validation;const resumed=await g.finish(prepared,{validationState:JSON.parse(JSON.stringify(completeState))});assert.equal(calls,3);assert.equal(resumed.grading.validation.reviewedHash,next.result.grading.validation.reviewedHash);
});
sourceTest('Bổ sung không được đổi verdict đã khóa; ID lạ không được ghép theo vị trí',async()=>{
 let responses=[];const g=await grader(async()=>envelope(responses.shift())),p=g.prepareWeb(answers(g)),v=ai(g,p),id=v.results[0].target_id;
 v.results[0]={target_id:id,verdict:'partial',error_code:'T-ABS',feedback:'',next_step:'Lần sau, hãy giữ đầy đủ quan hệ giữa các ý.'};responses.push(v);
 const first=await checkpoint(()=>g.finish(p));responses.push({results:[{target_id:id,verdict:'correct',feedback:'Em còn thiếu ý quan trọng cần nêu rõ hơn.'}]});const second=await checkpoint(()=>g.finish(p,{validationState:first.state}));assert.equal(second.state.value.results[0].verdict,'partial');assert.equal(second.state.lastRepairError.message,'AI_REPAIR_LOCKED_FIELD');
 const wrong=ai(g,p);wrong.results[0].target_id='wrong-person-target';await assert.rejects(()=>g.finish(p,{replayResponse:envelope(wrong)}),{code:'AI_IDENTITY_MISMATCH'});await assert.rejects(()=>g.finish(p,{validationState:{...first.state,inputFingerprint:'other'}}),{code:'VALIDATION_INPUT_MISMATCH'});
});
sourceTest('429 được hoãn; mất phản hồi không báo đã hoàn tất; giữ replay response',async()=>{
 let calls=0;const g=await grader(async()=>{calls++;throw Object.assign(Error('service'),{code:'AI_HTTP_429'});}),p=g.prepareWeb(answers(g));let rounds=[];const next=await checkpoint(()=>g.finish(p,{onRound:async e=>rounds.push(e)}));assert.equal(next.state.phase,'initial');assert.equal(rounds.at(-1).status,'failed');assert.equal(calls,1);
 const unknown=await grader(async()=>{throw Object.assign(Error('timeout'),{code:'AI_OUTCOME_UNKNOWN'});});await assert.rejects(()=>unknown.finish(p),{code:'AI_OUTCOME_UNKNOWN'});
 const good=ai(g,p);const replay=await checkpoint(()=>g.finish(p,{recoveredRound:{phase:'initial',call_id:'saved',response:envelope(good)}}));assert.equal(replay.state.phase,'review');assert.equal(calls,1);
});
test('Link Share: chỉ HTTPS /share/id, bỏ query; chặn /c, /s và host giả',()=>{
 const id='11111111-1111-4111-8111-111111111111';assert.equal(normalizeReadingShare('https://chat.openai.com/share/'+id+'?x=1'),'https://chatgpt.com/share/'+id);
 for(const url of ['https://chatgpt.com/c/'+id,'https://chatgpt.com/s/t_x','http://chatgpt.com/share/'+id,'https://chatgpt.com.evil/share/'+id,'https://user@chatgpt.com/share/'+id])assert.throws(()=>normalizeReadingShare(url),{code:'SHARE_URL_INVALID'});
});
test('Công nhận lời chatbot cả bài; chặn tự khai, lời trong prompt và mốc giữa bài',async()=>{
 const messages=[{role:'assistant',text:'Hãy nén câu tiếng Anh này.'},{role:'user',text:'Máy giúp lọc nước.'},{role:'assistant',text:'Bạn đã hoàn thành toàn bộ bài luyện nén thông tin hôm nay.'}];
 const analyze=async()=>({completed:true,matched:true,confidence:.99,scope:'whole_practice',message:3,quote:messages[2].text});
 assert.equal((await verifyReadingPractice({messages},'Nén cấp 1',analyze)).status,'accepted');
 await assert.rejects(()=>verifyReadingPractice({messages:[...messages.slice(0,2),{role:'user',text:messages[2].text}]},'Nén cấp 1',analyze),/COMPLETION_EVIDENCE_INVALID/);
 const quoted=messages.map(m=>({...m}));quoted[2].text='```\n'+messages[2].text+'\n```';await assert.rejects(()=>verifyReadingPractice({messages:quoted},'Nén cấp 1',analyze),/COMPLETION_QUOTED_EXAMPLE/);
 const unfinished=async()=>({completed:false,confidence:1});assert.equal((await verifyReadingPractice({messages},'Nén cấp 1',unfinished,async()=>null)).status,'rejected');
});
test('Mercy Rule: chỉ công nhận lời dừng có thật từ chatbot và đúng bài',async()=>{
 const messages=[{role:'user',text:'Tôi thử nén lại.'},{role:'assistant',text:'Bạn đã thử ba lần ở Level 2. Hôm nay chúng ta tạm nghỉ để tránh quá tải.'}];
 const result={stopped:true,matched:true,confidence:.99,reason:'mercy_rule',candidateId:'m1'};
 const call=async()=>new Response(JSON.stringify({text:JSON.stringify(result)}));assert.equal((await analyzeReadingStop(messages,'Reading nén cấp 1',call)).reason,'mercy_rule');
 result.candidateId='m99';await assert.rejects(()=>analyzeReadingStop(messages,'Reading nén cấp 1',call),{code:'SHARE_EVIDENCE_INVALID'});
});
async function database(t){const db=new PGlite();await db.exec('CREATE SCHEMA reading_listening67');await db.exec(await fs.readFile(new URL('../../docs/migrations/2026-10-29-reading67-share-practice.sql',import.meta.url),'utf8'));t.after(()=>db.close());return db;}
const a={ownerId:'11111111-1111-4111-8111-111111111111',courseId:'1293',code:'67-reading-the-desolenator',version:'v1'},b={...a,ownerId:'22222222-2222-4222-8222-222222222222'};
const url=id=>'https://chatgpt.com/share/'+id;
test('Hàng Share tách chủ, đổi link khi đang đọc, idempotency và giữ snapshot lịch sử',async t=>{
 const db=await database(t);let release,entered;const started=new Promise(resolve=>entered=resolve),gate=new Promise(resolve=>release=resolve);
 const service=createReadingSharePractice({db,content:{code:a.code,version:a.version,practice:{target:'Nén cấp 1'}},readShare:async()=>{entered();await gate;return {messages:[{role:'user',text:'Bài giả'}]};},verify:async()=>({status:'accepted',policy:'reading-skimming-l1-share-20261029-v1',message:'Đã đạt'})});
 const firstId=randomUUID();await service.save(a,{url:url(a.ownerId),requestId:firstId});assert.equal((await service.status(b)).status,'not_started');const processing=service.once();await started;
 const newId=randomUUID();await service.save(a,{url:url(b.ownerId),requestId:newId});release();await processing;assert.equal((await service.status(a)).status,'queued');assert.equal((await service.status(a)).url,url(b.ownerId));
 await assert.rejects(()=>service.save(a,{url:url(a.ownerId),requestId:firstId}),{code:'SHARE_REQUEST_SUPERSEDED'});
 assert.equal((await db.query('SELECT count(*)::int n FROM reading_listening67.web_share_practice_history')).rows[0].n,1);
 await service.once();assert.equal((await service.status(a)).status,'accepted');await db.transaction(tx=>service.requireAccepted(tx,a));await assert.rejects(()=>db.transaction(tx=>service.requireAccepted(tx,b)),{code:'PRACTICE_NOT_ACCEPTED'});
});
test('AI Share không rõ outcome: không tự gọi lại; người khác không bị tác động',async t=>{
 const db=await database(t);let calls=0;const service=createReadingSharePractice({db,content:{code:a.code,version:a.version,practice:{target:'Nén cấp 1'}},readShare:async()=>({messages:[{role:'user',text:'Dữ liệu giả'}]}),verify:async()=>{calls++;throw Error('network');}});
 await service.save(a,{url:url(a.ownerId),requestId:randomUUID()});await service.once();assert.equal((await service.status(a)).status,'needs_review');await service.save(a,{url:url(a.ownerId),requestId:randomUUID()});await service.once();assert.equal(calls,1);assert.equal((await service.status(b)).status,'not_started');
});
sourceTest('Nộp Reading yêu cầu Share accepted; bản gửi giữ 15 ô đúng scope',async t=>{
 const db=await database(t);await db.exec(await fs.readFile(new URL('../../docs/migrations/2026-10-22-reading67-web.sql',import.meta.url),'utf8'));await db.exec(await fs.readFile(new URL('../../docs/migrations/2026-10-26-reading67-validation.sql',import.meta.url),'utf8'));
 const g=await grader(),service=createReadingSharePractice({db,content:{code:a.code,version:a.version}}),store=createReading67WebStore({db,grader:g,beforeSubmit:service.requireAccepted,afterSubmit:service.attachAttempt});
 const draft=await store.save(a,{baseRevision:0,mutationId:randomUUID(),body:{answers:answers(g),notes:'Giữ nguyên',annotations:[],flags:[5]}});
 await assert.rejects(()=>store.submit(a,{revision:draft.revision,requestId:randomUUID()}),{code:'PRACTICE_NOT_ACCEPTED'});
 await service.save(a,{url:url(a.ownerId),requestId:randomUUID()});await db.query("UPDATE reading_listening67.web_share_practice SET status='accepted'");
 const sent=await store.submit(a,{revision:draft.revision,requestId:randomUUID()});assert.equal(Object.keys(sent.snapshot.answers).length,15);assert.equal(sent.snapshot.notes,'Giữ nguyên');await assert.rejects(()=>store.attempt(b,sent.attemptId),{code:'ATTEMPT_NOT_FOUND'});
 await service.save(a,{url:url(b.ownerId),requestId:randomUUID()});assert.equal((await service.status(a)).url,url(b.ownerId));assert.equal((await service.status(a,sent.attemptId)).url,url(a.ownerId));await assert.rejects(()=>service.status(b,sent.attemptId),{code:'PRACTICE_SNAPSHOT_NOT_FOUND'});
});
test('Tổng kết Headings từ kết quả đủ ID: 5 Heading + 10 nén, không dùng tổng Materials',()=>{
 const ids=['C','D','E','F','G'].flatMap(p=>['H','L1','L2'].map(k=>'L3.'+k+'.'+p)),grading={structure:{targetIds:ids,headingIds:ids.filter(id=>id.includes('.H.'))},target_results:ids.map(target_id=>({target_id,verdict:'correct'}))};
 assert.equal(reading67HeadingsSummary(grading).matchingTotal,5);assert.equal(reading67HeadingsSummary(grading).compressionTotal,10);grading.target_results.pop();assert.equal(reading67HeadingsSummary(grading),null);
});
