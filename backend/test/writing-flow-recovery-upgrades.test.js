// Nhận fixture lỗi và lượt chấm; kiểm chờ writer, hồ sơ mã hóa và biên nhận.
// Không có hệ thống ngoài; test thất bại khi backend có thể làm mất bằng chứng.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createWritingFlowStage,stageRetryPolicy,verifyWritingDeliveryResult} from '../src/writing-flow-stage.js';
import {open,sha256} from '../src/writing-flow-crypto.js';
const pairId='11111111-1111-4111-8111-111111111111',attemptId='22222222-2222-4222-8222-222222222222',revision='a'.repeat(64),encryptionKey='22'.repeat(32);
test('writer bận chờ 90 giây với mã riêng',()=>assert.deepEqual(stageRetryPolicy('deliver','TEST_WRITER_BUSY'),{retryImmediately:false,handoffDelaySeconds:90}));
test('lỗi được lưu mã hóa cùng attempt, replay không ghi lại hoặc mất dấu lỗi',async()=>{
 const writes=[];let recorded=false;
 const client={async query(sql,params=[]){
  if(sql.includes('SELECT submission_revision,status'))return {rowCount:1,rows:[{submission_revision:revision,status:'running'}]};
  if(sql.includes('SELECT status,cycle_no,attempt_count'))return {rowCount:1,rows:[{status:'running',cycle_no:1,attempt_count:1}]};
  if(sql.includes('SELECT cycle_no,attempt_no,status'))return {rowCount:1,rows:[{cycle_no:1,attempt_no:1,status:recorded?'failed':'sent'}]};
  if(sql.includes('UPDATE writing_flow.stage_attempt')){recorded=true;writes.push({sql,params});}
  if(sql.includes('INSERT INTO writing_flow.handoff'))return {rowCount:1,rows:[{handoff_id:'fixture-handoff'}]};
  return {rowCount:1,rows:[]};},release(){}};
 const stage=createWritingFlowStage({pool:{connect:async()=>client},encryptionKey});
 const input={pairId,revision,stageKey:'deliver',attemptId,errorCode:'TEST_WRITER_BUSY',failureEvidence:{message:'Thông báo gốc; Authorization: Bearer secret-should-not-survive; {"api_key":"FAKE_KEY_SHOULD_NOT_SURVIVE","token":"FAKE_TOKEN_SHOULD_NOT_SURVIVE"}',workflowId:'workflow-fixture',workflowVersion:'version-fixture',executionId:'execution-fixture'}};
 assert.equal((await stage.fail(input)).status,'retry_requested');
 const cipher=writes[0].params.find(Buffer.isBuffer);assert.ok(cipher,'Hồ sơ lỗi chưa được mã hóa/lưu cùng attempt');
 const saved=JSON.parse(open(cipher,Buffer.from(encryptionKey,'hex'))).failureEvidence;
 assert.equal(saved.workflowVersion,'version-fixture');assert.equal(saved.stageKey,'deliver');assert.match(saved.message,/Thông báo gốc/);assert.equal(saved.message.includes('secret-should-not-survive'),false);assert.ok(saved.recordedAt);
 assert.equal(saved.message.includes('FAKE_KEY_SHOULD_NOT_SURVIVE'),false);assert.equal(saved.message.includes('FAKE_TOKEN_SHOULD_NOT_SURVIVE'),false);
 assert.equal((await stage.fail(input)).status,'already_recorded');assert.equal(writes.length,1);
});
test('backend chặn delivered khi render mới yêu cầu kiểm nhưng receipt thiếu format hoặc nguồn',()=>{
 const rendered={reportMarkdown:'Bản tổng',verificationRequired:true,testComponents:Array.from({length:9},()=>({}))};
 const pair={homework_file_id:'fake-doc',essay_slot:1,source_link_index:1};
 const result={readbackOk:true,homeworkFileId:'fake-doc',essaySlot:1,sourceLinkIndex:1,writerPayloadHash:sha256('Bản tổng')};
 assert.throws(()=>verifyWritingDeliveryResult(result,rendered,pair,'term_test'),/chưa|Chưa|khớp/);
 result.verification={native_format_ok:true,source_preserved:true,criteria_count:4,detail_count:9};
 assert.doesNotThrow(()=>verifyWritingDeliveryResult(result,rendered,pair,'term_test'));
 result.verification.detail_count=8;assert.throws(()=>verifyWritingDeliveryResult(result,rendered,pair,'term_test'));
});
