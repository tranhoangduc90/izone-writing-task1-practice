import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createWritingFlowService } from '../src/writing-flow-service.js';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const NEW_REVISION = '33333333-3333-4333-8333-333333333333';
const HOMEWORK = '44444444-4444-4444-8444-444444444444';

// Nhận vào: bốn hồ sơ giả trong PostgreSQL nhúng: hai nguồn Test cùng khóa, bản mới và Homework.
// Việc chính: chạy chính câu SQL của danh sách quản trị ở chế độ Cần kiểm tra.
// Trả ra: chỉ hai nguồn Test cùng phiên bản; bản đã giao giữ nguyên nhưng hiện cảnh báo.
// Khi lỗi: test cho biết danh sách bị ẩn, ghép sai phiên bản hoặc ảnh hưởng Homework.
test('D03 PostgreSQL: hai nguồn Test cùng bài hiện để đối chiếu, Homework đứng ngoài', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA mapping;
      CREATE SCHEMA writing_flow;
      CREATE TABLE mapping.classroom_course_mapping
        (erp_course_class_id bigint,erp_class_name_snapshot text);
      CREATE TABLE mapping.reviewer_class_access
        (erp_course_class_id bigint,reviewer_email text);
      CREATE TABLE mapping.reviewer_account
        (email text,status text,display_name text);
      CREATE FUNCTION writing_flow.normalize_search(value text) RETURNS text
        LANGUAGE sql IMMUTABLE AS $$ SELECT lower(coalesce(value,'')) $$;
      CREATE TABLE writing_flow.pair (
        pair_id uuid PRIMARY KEY,class_code text,source_app_id text,source_table_id text,
        source_record_id text,homework_file_id text,source_link_index integer,essay_slot integer,
        task_type text,submission_revision text,status text,source_type text,
        created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now(),
        finished_at timestamptz,skipped_at timestamptz,skipped_by text,skip_reason text,
        trcc_required_override boolean,source_id uuid,source_ciphertext bytea);
      CREATE TABLE writing_flow.source_record (
        source_id uuid PRIMARY KEY,source_type text,source_app_id text,source_table_id text,source_record_id text,
        homework_file_id text,source_link_index integer,class_code text,
        display_name text,student_name text,teacher_names text[],
        classroom_url text,file_url text,source_status text,source_created_at timestamptz);
      CREATE TABLE writing_flow.class_registry
        (class_code text PRIMARY KEY,class_status text,eligibility_reason text);
      CREATE TABLE writing_flow.stage_result (
        pair_id uuid,stage_key text,status text,attempt_count integer,error_code text,
        result_ciphertext bytea,completed_at timestamptz,cycle_no integer);
      CREATE TABLE writing_flow.source_issue (
        source_app_id text,source_table_id text,source_record_id text,
        homework_file_id text,source_link_index integer,class_code text,status text,
        warning_confirmed_at timestamptz);
      CREATE TABLE writing_flow.manual_review
        (review_id uuid,pair_id uuid,stage_key text,cycle_no integer,status text,
         error_code text,opened_at timestamptz DEFAULT now(),checked_at timestamptz,
         retry_requested_at timestamptz);
      CREATE TABLE writing_flow.workflow_failure (last_seen_at timestamptz);
      CREATE TABLE writing_flow.trcc_repair (pair_id uuid,status text);
      CREATE TABLE writing_flow.test_group
        (test_group_id uuid PRIMARY KEY,test_config text,topology text);
      CREATE TABLE writing_flow.test_pair (
        pair_id uuid PRIMARY KEY,test_group_id uuid,task_number integer,
        historical_evidence jsonb,component_count integer,task_score numeric,status text);
      CREATE TABLE writing_flow.test_final
        (test_group_id uuid,writing_score numeric,status text);
      INSERT INTO writing_flow.class_registry VALUES ('IC2200','on_going','active');
      INSERT INTO writing_flow.pair (pair_id,class_code,source_app_id,source_table_id,
        source_record_id,homework_file_id,source_link_index,essay_slot,task_type,
        submission_revision,status,source_type) VALUES
        ('${FIRST}','IC2200','google_classroom','course-a','assignment-a',
          'doc-fake',1,1,'task_2','revision-one','delivered','term_test'),
        ('${SECOND}','IC2200','manual','manual','manual-a',
          'doc-fake',1,1,'task_2','revision-one','needs_review','term_test'),
        ('${NEW_REVISION}','IC2200','google_classroom','course-a','assignment-a',
          'doc-fake',1,1,'task_2','revision-two','received','term_test'),
        ('${HOMEWORK}','IC2200','lark','table-a','record-a',
          'doc-fake',1,1,'task_2','revision-one','received','lark_homework');
      INSERT INTO writing_flow.stage_result
        (pair_id,stage_key,status,attempt_count,error_code,cycle_no)
        VALUES ('${SECOND}','precheck','needs_review',0,
          'TEST_HISTORICAL_EVIDENCE_CONFLICT',1);
      INSERT INTO writing_flow.manual_review
        (review_id,pair_id,stage_key,cycle_no,status,error_code)
        VALUES ('55555555-5555-4555-8555-555555555555','${SECOND}',
          'precheck',1,'open',
          'TEST_HISTORICAL_EVIDENCE_CONFLICT');
    `);
    const pool = { query: (...args) => db.query(...args) };
    const service = createWritingFlowService({ pool });
    const review = await service.listPairs({ view: 'review', sourceKind: 'test' });
    assert.deepEqual(review.map(row => row.pair_id).sort(), [FIRST, SECOND].sort());
    const first = review.find(row => row.pair_id === FIRST);
    assert.equal(first.status, 'delivered');
    assert.equal(first.historical_review_code, 'TEST_HISTORICAL_EVIDENCE_CONFLICT');
    assert.deepEqual(first.historical_peer_pair_ids, [SECOND]);
    const delivered = await service.listPairs({ view: 'delivered', sourceKind: 'test' });
    assert.equal(delivered.some(row => row.pair_id === FIRST), true);
    const homeworkReview = await service.listPairs({ view: 'review', sourceKind: 'homework' });
    assert.equal(homeworkReview.length, 0);
    const counts = await service.dashboardCounts({ sourceKind: 'test' });
    assert.equal(counts.support.historical_reviews, 1);
    assert.equal(counts.support.reviews, 1);
    const reviews = await service.listReviews({ classCode: 'IC2200' });
    assert.equal(reviews.length, 1);
    assert.equal(reviews[0].historical_review_code, 'TEST_HISTORICAL_EVIDENCE_CONFLICT');
    assert.deepEqual(reviews[0].historical_peer_pair_ids, [FIRST]);
  } finally {
    await db.close();
  }
});
