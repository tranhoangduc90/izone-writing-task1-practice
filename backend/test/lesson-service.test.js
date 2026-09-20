import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createLessonPracticeService } from '../src/lesson-service.js';

test('dữ liệu response động ghi đè cột tương thích cũ khi tải lại Task 2', () => {
  const source = fs.readFileSync(new URL('../src/lesson-service.js', import.meta.url), 'utf8');
  const legacyFirst = /jsonb_strip_nulls\(jsonb_build_object\([\s\S]*?\)\s*\|\|COALESCE\(session\.response_data,'\{\}'::jsonb\)\) AS responses/g;
  const dynamicFirst = /jsonb_strip_nulls\(COALESCE\(session\.response_data,'\{\}'::jsonb\)\|\|jsonb_build_object/g;

  assert.equal([...source.matchAll(legacyFirst)].length, 2);
  assert.doesNotMatch(source, dynamicFirst);
});

test('dashboard lớp và phần chấm từng câu cùng nhận phân công Lark chưa materialize', async () => {
  let rosterQuery = '';
  const pool = { query: async (sql, params) => {
    if (sql.includes('SELECT activity.id,activity.grading_pool')) {
      assert.deepEqual(params, ['writing-task2-test']);
      return { rowCount: 1, rows: [{ id: 7, gradingPool: 'task1' }] };
    }
    if (sql.includes('FROM writing_practice.activity activity') && sql.includes('activity_roster roster')) {
      rosterQuery = sql;
      assert.deepEqual(params, ['writing-task2-test', null, false, 'teacher@example.invalid']);
      return { rowCount: 0, rows: [] };
    }
    throw new Error(`Truy vấn ngoài dự kiến: ${sql}`);
  } };
  const result = await createLessonPracticeService({ pool }).listLive({
    activitySlug: 'writing-task2-test',
    classRef: null,
    reviewerEmail: 'teacher@example.invalid',
    canAccessAllClasses: false,
  });
  assert.deepEqual(result.students, []);
  assert.match(rosterQuery, /mapping\.reviewer_class_access/u);
  assert.match(rosterQuery, /mapping\.lark_export_teacher_assignments/u);
  assert.match(rosterQuery, /scope\.erp_course_class_id=ANY\(assignment\.scope_class_ids\)/u);
});

test('backend từ chối Check khi phần bắt buộc trước đó chưa đạt', async () => {
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(sql);
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rowCount: 0, rows: [] };
      if (sql.includes('FROM writing_practice.activity_session WHERE public_id')) {
        return { rowCount: 1, rows: [{ id: 7, activity_id: 9, response_data: { idea1_a: 'A', idea1_x: 'X', idea1_b: 'B' } }] };
      }
      if (sql.includes('FROM writing_practice.activity_section_definition')) {
        return { rowCount: 1, rows: [{
          input_fields: ['idea1_a', 'idea1_x', 'idea1_b'],
          context_fields: [],
          required_fields: ['idea1_a', 'idea1_x', 'idea1_b'],
          validation_mode: 'all',
          prerequisite_sections: ['topic_sentence'],
        }] };
      }
      if (sql.includes('WHERE session_id=$1 AND section_key=$2 FOR UPDATE')) {
        return { rowCount: 1, rows: [{ locked: false, round_number: 1 }] };
      }
      if (sql.includes('section_key=ANY')) return { rowCount: 0, rows: [] };
      throw new Error(`Truy vấn ngoài dự kiến: ${sql}`);
    },
    release() {},
  };
  const pool = { connect: async () => client };
  const service = createLessonPracticeService({ pool });
  await assert.rejects(
    service.submitCheck({ sessionRef: 'session-ref', section: 'supporting_idea_1', requestId: 'request-ref' }),
    error => error.code === 'SECTION_PREREQUISITES_NOT_PASSED' && error.status === 409,
  );
  assert.equal(calls.at(-1), 'ROLLBACK');
});

test('giảng viên xếp chấm lại tạo attempt mới thay vì tái sử dụng lượt lỗi', async () => {
  const responses = [
    { rowCount: 1, rows: [{
      id: 'old-id', public_id: 'old-ref', session_id: 'session-id', section_key: 'body1_topic',
      round_number: 1, comment_number: 1, status: 'failed', body_hash: 'a'.repeat(64),
      snapshot: { body1_topic: 'Nội dung thử' }, locked: false
    }] },
    { rowCount: 0, rows: [] },
    { rowCount: 1, rows: [{ next: 2 }] },
    { rowCount: 1, rows: [{
      id: 'new-id', public_id: 'new-ref', section_key: 'body1_topic',
      comment_number: 2, status: 'queued', version: 1
    }] },
    { rowCount: 1, rows: [{ public_id: 'new-comment-ref' }] },
    { rowCount: 1, rows: [] }
  ];
  const calls = [];
  const client = {
    async query(sql) {
      calls.push(String(sql));
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rowCount: 0, rows: [] };
      const next = responses.shift();
      if (!next) throw new Error(`Truy vấn ngoài dự kiến: ${String(sql).slice(0, 80)}`);
      return next;
    },
    release() {}
  };

  const result = await createLessonPracticeService({ pool: { connect: async () => client } }).retryFailedAttempt({
    attemptRef: 'old-ref', actorRef: 'teacher@example.invalid'
  });

  assert.equal(result.attemptRef, 'new-ref');
  assert.equal(result.commentRef, 'new-comment-ref');
  assert.equal(calls.some(sql => sql.includes('INSERT INTO writing_practice.check_attempt')), true);
});
