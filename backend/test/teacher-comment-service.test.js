import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { relocateTeacherCommentAnchor } from '../src/teacher-comment-service.js';

test('comment giữ đúng đoạn khi học viên chèn chữ ở phía trước', () => {
  const anchor = relocateTeacherCommentAnchor('New: The figure rose sharply in 2009.', {
    start: 0,
    end: 28,
    quote: 'The figure rose sharply',
    prefix: '',
    suffix: ' in 2009.'
  });
  assert.equal(anchor.detached, false);
  assert.equal(anchor.start, 5);
  assert.equal(anchor.quote, 'The figure rose sharply');
});

test('comment không biến mất khi đoạn gốc bị xóa', () => {
  const anchor = relocateTeacherCommentAnchor('A completely rewritten sentence.', {
    start: 0,
    end: 22,
    quote: 'The figure rose sharply',
    prefix: '',
    suffix: ''
  });
  assert.equal(anchor.detached, true);
  assert.equal(anchor.quote, 'The figure rose sharply');
  assert.equal(anchor.start, null);
});

test('migration không cấp quyền DELETE và dọn comment đúng hạn cùng session', async () => {
  const sql = await readFile(new URL('../../docs/migrations/2026-08-16-add-persistent-teacher-comments.sql', import.meta.url), 'utf8');
  assert.match(sql, /GRANT SELECT,INSERT,UPDATE ON writing_practice\.teacher_comment_thread/);
  assert.doesNotMatch(sql, /GRANT[^;]*DELETE[^;]*teacher_comment/i);
  assert.match(sql, /DELETE FROM writing_practice\.teacher_comment_message/);
  assert.match(sql, /DELETE FROM writing_practice\.teacher_comment_thread/);
});
