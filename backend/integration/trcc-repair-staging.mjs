import assert from 'node:assert/strict';
import pg from 'pg';
import { createWritingFlowHandoff } from '../src/writing-flow-handoff.js';
import { createWritingFlowIntake } from '../src/writing-flow-intake.js';
import { createWritingFlowStage } from '../src/writing-flow-stage.js';
import { createWritingFlowTrccRepair } from '../src/writing-flow-trcc-repair.js';
import { keyFromHex, seal, sha256 } from '../src/writing-flow-crypto.js';

const pairId = 'f1000000-0000-4000-8000-000000000921';
const sourceId = 'f2000000-0000-4000-8000-000000000921';
const batchRequestId = 'f3000000-0000-4000-8000-000000000921';
const databaseUrl = new URL(process.env.DATABASE_URL || '');
if (databaseUrl.pathname.slice(1) !== 'writing_practice_staging') {
  throw new Error('TRCC_REPAIR_TEST_REQUIRES_STAGING_DATABASE');
}
const key = keyFromHex(process.env.WRITING_FLOW_ENCRYPTION_KEY);
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });

const topic = 'Some people think printed news will become less important.';
const essay = 'This is a synthetic essay used only to verify the TR and CC repair path.';
const sourceJson = JSON.stringify(['task_2', topic, '', essay, false]);
const revision = sha256(sourceJson);
const contentSha = sha256(JSON.stringify(['task_2', topic, '', essay]));

function encrypted(value) {
  const json = JSON.stringify(value);
  return { sha: sha256(json), ciphertext: seal(json, key) };
}

await pool.query(`INSERT INTO writing_flow.source_record
  (source_id,source_type,source_app_id,source_table_id,source_record_id,
   homework_file_id,source_link_index,display_name,class_code,student_name,
   teacher_names,classroom_url,file_url,source_status,source_created_at,
   source_updated_at,metadata,dispatch_status,acknowledged_at)
 VALUES ($1,'google_classroom','trcc-test-app','trcc-test-table','trcc-test-record',
   'trcc-test-doc',1,'Bài kiểm thử cứu TR/CC','TEST-TRCC','Học viên kiểm thử',
   ARRAY['Giảng viên kiểm thử'],NULL,'https://docs.google.com/document/d/trcc-test-doc/edit',
   'TURNED_IN',now(),now(),'{}'::jsonb,'acknowledged',now())`, [sourceId]);
await pool.query(`INSERT INTO writing_flow.pair
  (pair_id,source_app_id,source_table_id,source_record_id,homework_file_id,
   source_link_index,essay_slot,submission_revision,source_modified_at,
   content_sha256,class_code,task_type,document_kind,source_ciphertext,
   encryption_version,source_type,source_id,status,finished_at)
 VALUES ($1,'trcc-test-app','trcc-test-table','trcc-test-record','trcc-test-doc',
   1,1,$2,now(),$3,'TEST-TRCC','task_2','google_docs',$4,1,
   'google_classroom',$5,'delivered',now())`,
[pairId, revision, contentSha, seal(sourceJson, key), sourceId]);

const results = {
  intake: { operationKey: 'fixture', pairId },
  precheck: { taskType: 'task_2', lesson: 'Buổi 1', de_bai: topic, bai_lam: essay,
    source_units: [essay], source_batches: [{ batch_index: 0, batch_start: 0, units: [essay] }],
    source_unit_count: 1, batch_count: 1, tr_cc: '', trcc_mode: 'skipped' },
  main: { draft: { items: [] }, main_usage: {} },
  critic: { findings: [], critic_usage: {} },
  arbiter: { final_items: [], arbiter_usage: {} },
  render: { resultUrl: `https://ducizone.ddns.net/writing/shared/writing-essays/${'a'.repeat(48)}/view?v=1`,
    writerGroupId: 'a'.repeat(48), version: 1, correctionsCount: 1, readbackOk: true },
  deliver: { resultUrl: `https://ducizone.ddns.net/writing/shared/writing-essays/${'a'.repeat(48)}/view?v=1`,
    homeworkFileId: 'trcc-test-doc', essaySlot: 1, sourceLinkIndex: 1, readbackOk: true },
};
for (const [stageKey, value] of Object.entries(results)) {
  const saved = encrypted(value);
  await pool.query(`INSERT INTO writing_flow.stage_result
    (pair_id,stage_key,status,cycle_no,attempt_count,input_sha256,result_sha256,
     result_ciphertext,selected_attempt_no,completed_at)
    VALUES ($1,$2,'succeeded',1,1,$3,$4,$5,1,now())`,
  [pairId, stageKey, sha256(`input:${stageKey}`), saved.sha, saved.ciphertext]);
}

const repair = createWritingFlowTrccRepair({ pool,
  encryptionKey: process.env.WRITING_FLOW_ENCRYPTION_KEY });
const seeded = await repair.seed({ batchRequestId, limit: 20 });
assert.equal(seeded.seededCount, 1);
const due = await createWritingFlowHandoff({ pool }).due(20);
const repairHandoff = due.find(row => row.pairId === pairId && row.stageKey === 'trcc_repair');
assert.ok(repairHandoff);
const claim = await repair.claim({ pairId, revision, handoffId: repairHandoff.handoffId,
  executionId: 'staging-trcc-repair-test' });
assert.equal(claim.status, 'started');
assert.equal(claim.source.deBai, topic);
assert.equal(claim.source.baiLam, essay);
const repairedText = 'Nhận xét TR và CC kiểm thử đã được lưu đúng bài.';
const completion = await repair.complete({ pairId, revision,
  repairAttemptId: claim.repairAttemptId, operationKey: claim.operationKey,
  result: { text: repairedText, promptKey: 'staging-fixture', provider: 'fixture', route: 'fixture' } });
assert.equal(completion.nextStage, 'render');
const renderClaim = await createWritingFlowStage({ pool,
  encryptionKey: process.env.WRITING_FLOW_ENCRYPTION_KEY }).claim({ pairId, revision,
  stageKey: 'render', handoffId: completion.handoffId, executionId: 'staging-render-test' });
assert.equal(renderClaim.status, 'started');
assert.equal(renderClaim.previous.precheck.tr_cc, repairedText);
assert.equal(renderClaim.previous.precheck.trcc_mode, 'repair');

const stageRows = await pool.query(`SELECT stage_key,status,cycle_no
  FROM writing_flow.stage_result WHERE pair_id=$1 ORDER BY stage_key`, [pairId]);
const stages = Object.fromEntries(stageRows.rows.map(row => [row.stage_key, row]));
for (const stageKey of ['main','critic','arbiter']) {
  assert.equal(stages[stageKey].status, 'succeeded');
  assert.equal(stages[stageKey].cycle_no, 1);
}
assert.equal(stages.render.cycle_no, 2);
assert.equal(stages.deliver.cycle_no, 2);

const intake = createWritingFlowIntake({ pool,
  encryptionKey: process.env.WRITING_FLOW_ENCRYPTION_KEY });
const rescanned = await intake({ sourceType: 'google_classroom', sourceId,
  operationKey: 'staging-rescan', appId: 'trcc-test-app', tableId: 'trcc-test-table',
  recordId: 'trcc-test-record', docId: 'trcc-test-doc', linkIndex: 1,
  classCode: 'TEST-TRCC', sourceModifiedAt: new Date(Date.now() + 60_000).toISOString(),
  documentKind: 'google_docs', verifiedMime: 'application/vnd.google-apps.document',
  expectedCount: 1, sourceMeta: { teacherNames: [] },
  pairs: [{ essaySlot: 1, taskType: 'task_2', topic, image: '', essay, trCcCheck: true }] });
assert.equal(rescanned.receipts[0].status, 'existing');
assert.equal(rescanned.receipts[0].pairId, pairId);
console.log(JSON.stringify({ outcome: 'success', seeded: seeded.seededCount,
  repairStatus: completion.status, renderOverlay: true, fullRegradeAvoided: true }));
await pool.end();
