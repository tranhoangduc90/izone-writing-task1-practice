import assert from 'node:assert/strict';
import test from 'node:test';
import { createWritingFlowStage } from '../src/writing-flow-stage.js';
import { seal, sha256 } from '../src/writing-flow-crypto.js';

test('bàn giao bước chấm giữ đúng file, link và ô homework', async () => {
  const encryptionKey = '11'.repeat(32);
  const key = Buffer.from(encryptionKey, 'hex');
  const source = ['task_1', 'Đề giả', 'https://example.test/chart', 'Bài giả', true];
  const revision = sha256(JSON.stringify(source));
  const pairId = '11111111-1111-4111-8111-111111111111';
  const handoffId = '22222222-2222-4222-8222-222222222222';
  const inputHash = 'a'.repeat(64);
  const client = {
    async query(sql) {
      if (sql.includes('SELECT pair_id, submission_revision')) return {
        rowCount: 1, rows: [{
          pair_id: pairId, submission_revision: revision, status: 'received',
          source_ciphertext: seal(JSON.stringify(source), key),
          source_app_id: 'app-demo', source_table_id: 'table-demo',
          source_record_id: 'record-demo', homework_file_id: 'doc-demo',
          source_link_index: 2, essay_slot: 4, class_code: 'IC2200',
          document_kind: 'google_docs', source_modified_at: '2026-09-17T08:00:00Z',
          source_type: 'google_classroom', source_id: 'source-demo',
          source_display_name: 'Writing homework 4',
        }],
      };
      if (sql.includes('SELECT handoff_id, from_stage')) return {
        rowCount: 1, rows: [{ handoff_id: handoffId, from_stage: 'intake',
          to_stage: 'precheck', source_result_sha256: inputHash, status: 'pending' }],
      };
      if (sql.includes('SELECT pair_id, stage_key, status')) return {
        rowCount: 1, rows: [{ pair_id: pairId, stage_key: 'precheck',
          status: 'pending', cycle_no: 1, attempt_count: 0, input_sha256: inputHash }],
      };
      if (sql.includes('INSERT INTO writing_flow.stage_attempt')) return {
        rowCount: 1, rows: [{ attempt_id: '33333333-3333-4333-8333-333333333333' }],
      };
      if (sql.includes('SELECT stage_key,result_ciphertext')) return {
        rowCount: 1, rows: [{ stage_key: 'intake',
          result_ciphertext: seal(JSON.stringify({ operationKey: 'scan-demo' }), key) }],
      };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const stage = createWritingFlowStage({
    pool: { connect: async () => client }, encryptionKey,
  });
  const result = await stage.claim({ pairId, revision, stageKey: 'precheck',
    handoffId, executionId: 'execution-demo' });
  assert.equal(result.status, 'started');
  assert.deepEqual(result.source, {
    taskType: 'task_1', topic: 'Đề giả',
    image: 'https://example.test/chart', essay: 'Bài giả', trCcCheck: true,
    appId: 'app-demo', tableId: 'table-demo',
    recordId: 'record-demo', homeworkFileId: 'doc-demo',
    sourceLinkIndex: 2, essaySlot: 4, classCode: 'IC2200',
    documentKind: 'google_docs',
    sourceType: 'google_classroom', sourceId: 'source-demo',
    sourceDisplayName: 'Writing homework 4',
    sourceModifiedAt: '2026-09-17T08:00:00.000Z',
  });
  assert.deepEqual(result.previous.intake, { operationKey: 'scan-demo' });
});

test('retry sau kiểm tra dùng khóa lệnh riêng mà không làm đổi hash đầu vào bước chấm', async () => {
  const encryptionKey = '11'.repeat(32);
  const key = Buffer.from(encryptionKey, 'hex');
  const source = ['task_1', 'Đề giả', 'https://example.test/chart', 'Bài giả', true];
  const revision = sha256(JSON.stringify(source));
  const pairId = '31111111-1111-4111-8111-111111111111';
  const handoffId = '32222222-2222-4222-8222-222222222222';
  const reviewId = '33333333-3333-4333-8333-333333333333';
  const requestId = '34444444-4444-4444-8444-444444444444';
  const commandHash = sha256(requestId);
  let attemptInserted = false;
  let reviewAccepted = false;
  const client = {
    async query(sql) {
      if (sql.includes('SELECT pair_id, submission_revision')) return {
        rowCount: 1, rows: [{
          pair_id: pairId, submission_revision: revision, status: 'needs_review',
          source_ciphertext: seal(JSON.stringify(source), key),
          source_app_id: 'app-demo', source_table_id: 'table-demo',
          source_record_id: 'record-demo', homework_file_id: 'doc-demo',
          source_link_index: 1, essay_slot: 1, class_code: 'IC2200',
          document_kind: 'google_docs', source_modified_at: '2026-09-21T01:00:00Z',
        }],
      };
      if (sql.includes('SELECT handoff_id, from_stage')) return {
        rowCount: 1, rows: [{ handoff_id: handoffId, from_stage: 'review',
          to_stage: 'precheck', source_result_sha256: commandHash, status: 'sent' }],
      };
      if (sql.includes('SELECT pair_id, stage_key, status')) return {
        rowCount: 1, rows: [{ pair_id: pairId, stage_key: 'precheck',
          status: 'needs_review', cycle_no: 1, attempt_count: 3,
          input_sha256: 'a'.repeat(64), error_code: 'PRECHECK_FAILED' }],
      };
      if (sql.includes('SELECT review_id, cycle_no')) return {
        rowCount: 1, rows: [{ review_id: reviewId, cycle_no: 1,
          status: 'retry_requested', retry_command_key: requestId }],
      };
      if (sql.includes("SET status='retry_accepted'")) reviewAccepted = true;
      if (sql.includes('INSERT INTO writing_flow.stage_attempt')) {
        attemptInserted = true;
        return { rowCount: 1, rows: [{ attempt_id: '35555555-5555-4555-8555-555555555555' }] };
      }
      if (sql.includes('SELECT stage_key,result_ciphertext')) return {
        rowCount: 1, rows: [{ stage_key: 'intake',
          result_ciphertext: seal(JSON.stringify({ operationKey: 'scan-review' }), key) }],
      };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const result = await createWritingFlowStage({
    pool: { connect: async () => client }, encryptionKey,
  }).claim({ pairId, revision, stageKey: 'precheck', handoffId,
    executionId: 'review-retry-execution' });
  assert.equal(result.status, 'started');
  assert.equal(reviewAccepted, true);
  assert.equal(attemptInserted, true);
  assert.deepEqual(result.previous.intake, { operationKey: 'scan-review' });
});

test('bước giao link nhận phiên bản trang mới chỉ khi đã đánh dấu xuất lại', async () => {
  const encryptionKey = '11'.repeat(32);
  const key = Buffer.from(encryptionKey, 'hex');
  const source = ['task_2', 'Đề giả', '', 'Bài giả', false];
  const revision = sha256(JSON.stringify(source));
  const pairId = '41111111-1111-4111-8111-111111111111';
  const handoffId = '42222222-2222-4222-8222-222222222222';
  const oldHash = 'a'.repeat(64);
  const newHash = 'b'.repeat(64);
  const updates = [];
  const client = {
    async query(sql, params = []) {
      if (sql.includes('SELECT pair_id, submission_revision')) return {
        rowCount: 1, rows: [{
          pair_id: pairId, submission_revision: revision, status: 'running',
          source_ciphertext: seal(JSON.stringify(source), key),
          source_app_id: 'app-demo', source_table_id: 'table-demo',
          source_record_id: 'record-demo', homework_file_id: 'doc-demo',
          source_link_index: 1, essay_slot: 1, class_code: 'IC2200',
          document_kind: 'google_docs', source_modified_at: '2026-09-19T08:00:00Z',
        }],
      };
      if (sql.includes('SELECT handoff_id, from_stage')) return {
        rowCount: 1, rows: [{ handoff_id: handoffId, from_stage: 'render',
          to_stage: 'deliver', source_result_sha256: newHash, status: 'pending' }],
      };
      if (sql.includes('SELECT pair_id, stage_key, status')) return {
        rowCount: 1, rows: [{ pair_id: pairId, stage_key: 'deliver',
          status: 'pending', cycle_no: 2, attempt_count: 0,
          input_sha256: oldHash, error_code: 'REPUBLISH_REQUESTED' }],
      };
      if (sql.includes('SET input_sha256=$3')) {
        updates.push(params);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO writing_flow.stage_attempt')) return {
        rowCount: 1, rows: [{ attempt_id: '43333333-3333-4333-8333-333333333333' }],
      };
      if (sql.includes('SELECT stage_key,result_ciphertext')) return {
        rowCount: 1, rows: [{ stage_key: 'render',
          result_ciphertext: seal(JSON.stringify({ resultUrl: 'https://example.test/view?v=2' }), key) }],
      };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const stage = createWritingFlowStage({
    pool: { connect: async () => client }, encryptionKey,
  });
  const result = await stage.claim({ pairId, revision, stageKey: 'deliver',
    handoffId, executionId: 'execution-republish' });
  assert.equal(result.status, 'started');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], [pairId, 'deliver', newHash]);
});

test('bàn giao đã đóng trong hàng n8n không được tạo lượt thử mới', async () => {
  const encryptionKey = '11'.repeat(32);
  const pairId = '51111111-1111-4111-8111-111111111111';
  let queriedStage = false;
  let insertedAttempt = false;
  const client = {
    async query(sql) {
      if (sql.includes('SELECT pair_id, submission_revision')) return {
        rowCount: 1, rows: [{ pair_id: pairId, submission_revision: 'revision-demo',
          status: 'running' }],
      };
      if (sql.includes('SELECT handoff_id, from_stage')) return {
        rowCount: 1, rows: [{ handoff_id: '52222222-2222-4222-8222-222222222222',
          from_stage: 'render', to_stage: 'deliver', source_result_sha256: 'a'.repeat(64),
          status: 'acknowledged' }],
      };
      if (sql.includes('SELECT pair_id, stage_key, status')) queriedStage = true;
      if (sql.includes('INSERT INTO writing_flow.stage_attempt')) insertedAttempt = true;
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const result = await createWritingFlowStage({
    pool: { connect: async () => client }, encryptionKey,
  }).claim({ pairId, revision: 'revision-demo', stageKey: 'deliver',
    handoffId: '52222222-2222-4222-8222-222222222222', executionId: 'stale-execution' });
  assert.equal(result.status, 'superseded');
  assert.equal(queriedStage, false);
  assert.equal(insertedAttempt, false);
});

test('bước sau retry nhận đúng hash mới một lần khi khóa đầu vào đã được xóa', async () => {
  const encryptionKey = '11'.repeat(32);
  const key = Buffer.from(encryptionKey, 'hex');
  const source = ['task_2', 'Đề giả', '', 'Bài giả', false];
  const revision = sha256(JSON.stringify(source));
  const pairId = '61111111-1111-4111-8111-111111111111';
  const newHash = 'c'.repeat(64);
  const updates = [];
  const client = {
    async query(sql, params = []) {
      if (sql.includes('SELECT pair_id, submission_revision')) return {
        rowCount: 1, rows: [{ pair_id: pairId, submission_revision: revision,
          status: 'running', source_ciphertext: seal(JSON.stringify(source), key),
          source_link_index: 1, essay_slot: 1, document_kind: 'google_docs',
          source_modified_at: '2026-09-20T05:00:00Z' }],
      };
      if (sql.includes('SELECT handoff_id, from_stage')) return {
        rowCount: 1, rows: [{ handoff_id: '62222222-2222-4222-8222-222222222222',
          from_stage: 'critic', to_stage: 'render', source_result_sha256: newHash,
          status: 'sent' }],
      };
      if (sql.includes('SELECT pair_id, stage_key, status')) return {
        rowCount: 1, rows: [{ pair_id: pairId, stage_key: 'render', status: 'pending',
          cycle_no: 2, attempt_count: 0, input_sha256: 'a'.repeat(64),
          error_code: 'UPSTREAM_RETRY_REQUESTED' }],
      };
      if (sql.includes('SET input_sha256=$3')) {
        updates.push(params);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('INSERT INTO writing_flow.stage_attempt')) return {
        rowCount: 1, rows: [{ attempt_id: '63333333-3333-4333-8333-333333333333' }],
      };
      if (sql.includes('SELECT stage_key,result_ciphertext')) return {
        rowCount: 1, rows: [{ stage_key: 'critic',
          result_ciphertext: seal(JSON.stringify({ findings: [] }), key) }],
      };
      return { rowCount: 1, rows: [] };
    },
    release() {},
  };
  const result = await createWritingFlowStage({
    pool: { connect: async () => client }, encryptionKey,
  }).claim({ pairId, revision, stageKey: 'render',
    handoffId: '62222222-2222-4222-8222-222222222222', executionId: 'fresh-execution' });
  assert.equal(result.status, 'started');
  assert.deepEqual(updates[0], [pairId, 'render', newHash]);
});
