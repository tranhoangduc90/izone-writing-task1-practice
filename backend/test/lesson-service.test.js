import test from 'node:test';
import assert from 'node:assert/strict';
import { createLessonPracticeService } from '../src/lesson-service.js';

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
