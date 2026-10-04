// Nhận vào: PostgreSQL nhúng với canonical đã giao và peer có bằng chứng tranh chấp.
// Việc chính: chạy Retry thật để kiểm SQL guard và các biên Docs/Task/ô/revision/nguồn.
// Kết quả: tranh chấp không phát handoff, các hồ sơ khác vẫn Retry; không hệ thống ngoài.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import { createWritingFlowOperations, STAGES } from '../src/writing-flow-operations.js';
const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
async function runCase({stage='deliver',peerChanges={},expectBlocked=true,missingGrade=null}={}) {
  const db=new PGlite();
  try {
    await db.exec(`CREATE SCHEMA writing_flow;
      CREATE TABLE writing_flow.pair(pair_id uuid PRIMARY KEY,status text,source_type text,skipped_at timestamptz,
        homework_file_id text,essay_slot integer,task_type text,submission_revision text,
        source_app_id text,source_table_id text,source_record_id text,source_link_index integer,
        finished_at timestamptz,updated_at timestamptz);
      CREATE TABLE writing_flow.stage_result(pair_id uuid,stage_key text,status text,cycle_no integer,attempt_count integer,
        input_sha256 text,result_sha256 text,error_code text,result_ciphertext bytea,selected_attempt_no integer,
        n8n_execution_id text,started_at timestamptz,lease_expires_at timestamptz,completed_at timestamptz,updated_at timestamptz);
      CREATE TABLE writing_flow.manual_review(pair_id uuid,status text,resolved_at timestamptz);
      CREATE TABLE writing_flow.handoff(pair_id uuid,from_stage text,to_stage text,source_result_sha256 text,status text,
        next_send_at timestamptz,acknowledged_at timestamptz,error_code text);
      CREATE TABLE writing_flow.operator_event(event_id uuid DEFAULT '55555555-5555-4555-8555-555555555555',source_id uuid,pair_id uuid,event_type text,actor_ref text,request_id uuid,
        reason text,before_state jsonb,after_state jsonb);`);
    const base={doc:'fake-doc',slot:1,task:'task_2',revision:'r'.repeat(64),source:'term_test',app:'classroom',table:'course',record:'A',link:1,status:'needs_review'};
    const peer={...base,app:'manual',table:'manual',record:'B',...peerChanges};
    for(const [id,row,status] of [[first,base,'delivered'],[second,peer,peer.status]]) {
      await db.query(`INSERT INTO writing_flow.pair(pair_id,status,source_type,homework_file_id,essay_slot,task_type,
        submission_revision,source_app_id,source_table_id,source_record_id,source_link_index,finished_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())`,[id,status,row.source,row.doc,row.slot,row.task,row.revision,row.app,row.table,row.record,row.link]);
    }
    for(const stageKey of STAGES) await db.query(`INSERT INTO writing_flow.stage_result
      (pair_id,stage_key,status,cycle_no,attempt_count,input_sha256,result_sha256,error_code) VALUES($1,$2,'succeeded',1,1,$3,$3,NULL)`,[first,stageKey,'a'.repeat(64)]);
    if(missingGrade)await db.query('UPDATE writing_flow.stage_result SET result_sha256=NULL WHERE pair_id=$1 AND stage_key=$2',[first,missingGrade]);
    const savedGrades=(await db.query(`SELECT stage_key,status,result_sha256,cycle_no,attempt_count FROM writing_flow.stage_result WHERE pair_id=$1 AND stage_key IN ('main','critic','arbiter') ORDER BY stage_key`,[first])).rows;
    await db.query(`INSERT INTO writing_flow.stage_result(pair_id,stage_key,status,cycle_no,attempt_count,error_code)
      VALUES($1,'precheck','needs_review',1,0,'TEST_HISTORICAL_EVIDENCE_CONFLICT')`,[second]);
    const client={async query(...args){const result=await db.query(...args);return {...result,rowCount:result.rows.length||result.affectedRows||0};},release(){}};
    const ops=createWritingFlowOperations({pool:{query:client.query,connect:async()=>client}});
    let result,error;
    try {result=await ops.requestStageRetry({pairId:first,stageKey:stage,requestId:'33333333-3333-4333-8333-333333333333',actorRef:'fixture@example.invalid',reason:'stale UI fixture'});} catch(e){error=e;}
    const state=(await db.query('SELECT status FROM writing_flow.pair WHERE pair_id=$1',[first])).rows[0].status;
    const count=Number((await db.query('SELECT count(*) AS n FROM writing_flow.handoff')).rows[0].n);
    if(missingGrade) {assert.equal(count,0);assert.equal(error?.code,'TEST_SAVED_GRADE_NOT_READY');assert.equal(state,'delivered');}
    else if(expectBlocked) {assert.equal(count,0,'Canonical có tranh chấp đã phát handoff');assert.equal(error?.code,'TEST_HISTORICAL_EVIDENCE_CONFLICT');assert.equal(state,'delivered');}
    else {assert.equal(error,undefined,error?.message);assert.equal(result.status,'retry_requested');assert.equal(count,1);assert.equal(state,'running');}
    if(['render','deliver'].includes(stage))assert.deepEqual((await db.query(`SELECT stage_key,status,result_sha256,cycle_no,attempt_count FROM writing_flow.stage_result WHERE pair_id=$1 AND stage_key IN ('main','critic','arbiter') ORDER BY stage_key`,[first])).rows,savedGrades,'Phục hồi đã đổi bản chấm AI hoặc mở lượt AI mới');
  } finally {await db.close();}
}
for(const stage of ['precheck','deliver']) test('SQL guard canonical chặn '+stage,()=>runCase({stage}));
for(const stage of ['render','deliver']){
 test('Phục hồi '+stage+' giữ nguyên bản chấm và không tạo lượt AI',()=>runCase({stage,peerChanges:{doc:'other-doc'},expectBlocked:false}));
 for(const missingGrade of ['main','critic'])test('Phục hồi '+stage+' chặn bản chấm thiếu '+missingGrade,()=>runCase({stage,peerChanges:{doc:'other-doc'},expectBlocked:false,missingGrade}));
}
for(const peerChanges of [{doc:'other-doc'},{slot:2},{task:'task_1'},{revision:'n'.repeat(64)},{source:'google_classroom'},{app:'classroom',table:'course',record:'A'},{status:'superseded'}])
  test('SQL guard không ghép nhầm '+JSON.stringify(peerChanges),()=>runCase({peerChanges,expectBlocked:false}));
