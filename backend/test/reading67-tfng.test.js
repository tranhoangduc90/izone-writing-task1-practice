/* Ca mới bảo vệ rubric theo mảnh và đủ 42 kết quả; suite Materials hiện có bảo vệ retry/lease/Docs dùng chung. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadReading67TfngGrader} from '../src/reading-listening67/web-tfng-grader.js';
import {sha256} from '../src/reading-listening67/web-grader.js';
import {reading67ResultSummary,reading67ProgressText} from '../src/reading-listening67/web-result-summary.js';
const providerResponse=value=>({gatewayMeta:{model_id:'fixture-model',thinking_level:'medium',worker:'fixture-worker',dispatcher_worker:'fixture-dispatcher'},candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(value)}]}}]});
function fixture(){
 const targets=[],questions=[],answers={};
 for(let q=1;q<=6;q++){
  questions.push({number:q,text:'A synthetic statement '+q,answer:q===4?'NOT GIVEN':'TRUE'});
  const add=(id,kind,answer)=>{const oracle={core_units:[{id:'meaning',text:'The evidence keeps the supplied meaning.'}],secondary_required_units:[],optional_units:[],required_relation:{id:'relation',applicable:false},economy_applicable:false,critical_failures:[]};if(kind!=='evidence')oracle.fixedDecision={verdict:'incorrect',error_code:'LABEL_WRONG'};targets.push({id,kind,question:q,answer,modelAnswer:answer||'Synthetic source meaning.',oracle,explanation:'Giải thích giả để kiểm bộ chấm.',sourceParagraphs:['1']});answers[id]=answer||'The evidence keeps the supplied meaning.';};
  for(let m=1;m<=3;m++){add(`q${q}.m${m}.evidence`,'evidence',null);add(`q${q}.m${m}.label`,'chunk_label',q===4&&m===2?'NOT GIVEN':'TRUE');}
  add(`q${q}.conclusion`,'conclusion',q===4?'NOT GIVEN':'TRUE');
 }
 return {definition:{kind:'tfng',code:'synthetic-tfng',version:'fixture-v1',lessonId:'synthetic-l12',promptVersion:'prompt-fixture',oracleVersion:'oracle-fixture',providerUrl:'https://ducizone.ddns.net/fixture-no-network',model:{name:'fixture-model',thinking:'medium'},paragraphs:[{id:'1',text:'Synthetic source meaning.'}],questions,targets},answers};
}
function audit(prepared,{wrongReason='Em đang chọn sai nhãn so với thông tin trong bài đọc.'}={}){
 const profile=prepared.graded.stability_decision_profile;
 return {schema_version:profile.ai_schema_version,lesson_id:profile.lesson_id,prompt_version:profile.prompt_version,oracle_version:profile.oracle_version,results:prepared.graded.semantic_targets.map(t=>({target_id:t.target_id,unit_audit:[{unit_id:'meaning',status:'present',student_span:t.student_response}],relation_status:'not_applicable',economy_status:'not_applicable',critical_failure:null,primary_issue_unit_id:null,proposed_error_code:null,why_student_wrong:profile.structured_oracles[t.target_id].fixedDecision?wrongReason:''})).reverse()};
}
async function setup(t,provider){const f=fixture(),dir=await mkdtemp(path.join(tmpdir(),'reading-tfng-')),file=path.join(dir,'rubric.json'),bytes=JSON.stringify(f.definition);await writeFile(file,bytes);t.after(()=>rm(dir,{recursive:true,force:true}));return {...f,grader:await loadReading67TfngGrader({snapshotPath:file,expectedSha256:sha256(bytes),provider})};}
async function pending(fn){try{await fn();assert.fail('Expected pending validation');}catch(e){assert.equal(e.code,'AI_REPAIR_PENDING');return e.details.state;}}
const reviews=prepared=>({results:prepared.graded.semantic_targets.map(t=>({target_id:t.target_id,accepted:true,scope:'feedback',fields:[],problems:[]}))});
test('42 trường: chặn thiếu nội dung, nhận cờ đến câu 6 và đảo thứ tự phản hồi vẫn đúng từng ô',async t=>{
 let response,calls=0;const f=await setup(t,async()=>{calls++;return providerResponse(response);});
 assert.equal(f.grader.inspectWeb({}).completeness.eligible_for_grading,false);
 const missing={...f.answers};delete missing['q4.m2.evidence'];assert.equal(f.grader.inspectWeb(missing).completeness.filled_cells,41);
 const prepared=f.grader.prepareWeb(f.answers,'operation-A');assert.equal(prepared.graded.semantic_targets.length,18);
 response=audit(prepared);const state=await pending(()=>f.grader.finish(prepared));assert.equal(state.phase,'review');
 response=reviews(prepared);let completedState;const result=await f.grader.finish(prepared,{validationState:JSON.parse(JSON.stringify(state)),onCheckpoint:s=>{completedState=structuredClone(s);}});
 assert.equal(result.grading.target_results.length,42);assert.equal(calls,2);
 const p=reading67ResultSummary(result);assert.equal(p.allCorrect,true);assert.equal(p.evidenceCorrect,18);assert.equal(p.labelCorrect,18);assert.equal(p.conclusionCorrect,6);assert.match(reading67ProgressText(p),/6\/6/);
 const incomplete=structuredClone(result);incomplete.grading.target_results.pop();assert.equal(reading67ResultSummary(incomplete),null);
 await f.grader.finish(prepared,{validationState:completedState});assert.equal(calls,2,'Checkpoint hoàn tất không gọi lại AI');
});
test('Kết luận sai được giữ sai dù audit nói present; AI bổ sung hướng sửa rồi mới hoàn tất',async t=>{
 let response;const f=await setup(t,async()=>providerResponse(response));f.answers['q4.conclusion']='FALSE';
 const prepared=f.grader.prepareWeb(f.answers,'operation-B');response=audit(prepared);
 let state=await pending(()=>f.grader.finish(prepared));assert.equal(state.phase,'repair');assert.deepEqual(state.issues.map(i=>i.field),['next_step']);
 response={results:[{target_id:'q4.conclusion',next_step:'Lần sau, phân biệt thông tin không được đề cập với thông tin trái ngược.'}]};
 state=await pending(()=>f.grader.finish(prepared,{validationState:state}));assert.equal(state.phase,'review');
 response=reviews(prepared);const result=await f.grader.finish(prepared,{validationState:state});
 assert.equal(result.feedback['q4.conclusion'].status,'incorrect');assert.match(result.feedback['q4.conclusion'].nextStep,/^Lần sau,/);
 const p=reading67ResultSummary(result);assert.equal(p.conclusionCorrect,5);assert.equal(p.remainingCount,1);assert.equal(p.allCorrect,false);
});
test('Bổ sung quá ba vòng vẫn pending; phần đã khóa và định danh khác bị từ chối',async t=>{
 let response;const f=await setup(t,async()=>providerResponse(response));f.answers['q4.conclusion']='FALSE';
 const prepared=f.grader.prepareWeb(f.answers);response=audit(prepared);let state=await pending(()=>f.grader.finish(prepared));
 response={results:[{target_id:'q4.conclusion',next_step:'Lần sau, sửa.',unit_audit:[{unit_id:'meaning',status:'absent',student_span:null}]}]};
 for(let i=0;i<4;i++)state=await pending(()=>f.grader.finish(prepared,{validationState:state}));
 assert.equal(state.phase,'repair');assert.ok(state.round>=5);assert.equal(state.lastRepairError.code,'AI_REPAIR_LOCKED_FIELD');
 assert.equal(state.aiValue.results.find(r=>r.target_id==='q4.conclusion').unit_audit[0].status,'present');
 response=audit(prepared);response.results[0].target_id='foreign-target';
 await assert.rejects(()=>f.grader.finish(prepared),e=>e.code==='AI_IDENTITY_MISMATCH');
});
