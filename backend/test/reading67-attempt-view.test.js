// Đọc bài giả trên SQL thật: giữ đủ dữ liệu và quyền, tối đa một lượt đi–về DB.
// Không dùng AI, Google hoặc dữ liệu production; lỗi làm test thất bại rõ ràng.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createReading67WebStore} from '../src/reading-listening67/web-store.js';

const ids=['target-0','target-1'];
const grader={validationVersion:'fixture-v1',pins:{sha256:'fixture'},profile:{expected_target_ids:ids},
  inspectWeb:answers=>({parsed:{targets:ids.map(id=>({target_id:id,source_text:answers[id]||''}))},completeness:{eligible_for_grading:true,filled_cells:2}})};
const scope={ownerId:'owner-fixture',courseId:'class-fixture',code:'lesson-fixture',version:'v1'};
const body={answers:{'target-0':'Bài giả thứ nhất.','target-1':'Bài giả thứ hai.'},notes:'Giữ dấu → và xuống dòng\nDòng hai.',flags:[],annotations:[]};
async function fixture(t,validation=true){
  const db=new PGlite();t.after(()=>db.close());
  for(const name of ['2026-10-22-reading67-web.sql',...(validation?['2026-10-26-reading67-validation.sql']:[])])await db.exec(await fs.readFile(new URL('../../docs/migrations/'+name,import.meta.url),'utf8'));
  let measured=false,queries=0;
  const facade={query(...args){if(measured)queries++;return db.query(...args);},transaction:fn=>db.transaction(fn)};
  const store=createReading67WebStore({db:facade,grader:validation?grader:{...grader,validationVersion:undefined}});
  await store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});
  const sent=await store.submit(scope,{revision:1,requestId:randomUUID()});
  await db.query("UPDATE reading_listening67.web_attempt SET created_at='2026-11-03T12:00:00Z' WHERE id=$1",[sent.attemptId]);
  return {db,store,sent,async read(){queries=0;measured=true;try{return {value:await store.attempt(scope,sent.attemptId),get queries(){return queries;}};}finally{measured=false;}}};
}
function expected(sent,validationProgress=null,recovery=null){return {attemptId:sent.attemptId,jobId:sent.jobId,status:'queued',errorCode:null,createdAt:'2026-11-03T12:00:00.000Z',finishedAt:null,runNo:1,draftRevision:1,snapshot:body,completeness:{eligible_for_grading:true,filled_cells:2},result:null,progress:null,validationProgress,recovery,graderHash:'fixture',fromCache:false};}
const serialized=value=>JSON.parse(JSON.stringify(value));

test('Chi tiết bài giữ null khi chưa có checkpoint/khôi phục và chỉ đọc một lượt SQL',async t=>{
  const f=await fixture(t),read=await f.read();assert.deepEqual(serialized(read.value),expected(f.sent));
  assert.equal(read.queries,1,'Một lần đọc chi tiết không phát ba truy vấn nối tiếp');
});
test('Chi tiết giữ đủ checkpoint và lần phục hồi đầu tiên, không nhân hàng hay mất snapshot',async t=>{
  const f=await fixture(t),state={phase:'repair',round:3,serviceError:{code:'FIXTURE_UPSTREAM'},issues:[{targetId:'target-0'}]};
  await f.db.query('INSERT INTO reading_listening67.web_validation(job_id,state) VALUES($1,$2)',[f.sent.jobId,JSON.stringify(state)]);
  for(const [at,code]of [['2026-11-03T12:02:00Z','LATER'],['2026-11-03T12:01:00Z','FIRST']])await f.db.query("INSERT INTO reading_listening67.web_validation_event(id,job_id,kind,data,created_at) VALUES($1,$2,'recovery_started',$3,$4)",[randomUUID(),f.sent.jobId,JSON.stringify({previous:{error_code:code,finished_at:'2026-11-03T11:59:00Z'}}),at]);
  const read=await f.read();assert.deepEqual(serialized(read.value),expected(f.sent,{phase:'repair',round:'3',service_error:{code:'FIXTURE_UPSTREAM'},pending:1},{error_code:'FIRST',failed_at:'2026-11-03T11:59:00Z',started_at:'2026-11-03T12:01:00.000Z'}));
  assert.equal(read.queries,1,'Checkpoint và khôi phục phải nằm trong cùng lượt đọc');
  for(const field of ['ownerId','courseId','code','version'])await assert.rejects(f.store.attempt({...scope,[field]:'other-fixture'},f.sent.attemptId),{code:'ATTEMPT_NOT_FOUND'});
});
test('Engine chưa bật validation vẫn đọc một lần và không cần bảng validation',async t=>{
  const f=await fixture(t,false),read=await f.read();assert.deepEqual(serialized(read.value),expected(f.sent));assert.equal(read.queries,1);
});
