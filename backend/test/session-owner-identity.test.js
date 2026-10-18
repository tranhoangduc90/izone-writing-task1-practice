// SQL thật trên PostgreSQL nhúng; chỉ đọc phiên giả để kiểm định danh và giữ nội dung bài.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const candidate = process.env.WRITING_OWNER_RUNTIME;
if (candidate) {
  const proof = JSON.parse(await readFile(path.join(candidate,'owner-patch-proof.json'),'utf8'));
  for (const file of proof.files) assert.equal(createHash('sha256').update(await readFile(path.join(candidate,file.path))).digest('hex'),file.patchedSha);
}
const source = candidate ? pathToFileURL(path.resolve(candidate,'src')+path.sep) : new URL('../src/',import.meta.url);
const { createWritingPracticeService } = await import(new URL('service.js',source));
const { createLessonPracticeService } = await import(new URL('lesson-service.js',source));
const a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const ca = '33333333-3333-4333-8333-333333333333', cb = '44444444-4444-4444-8444-444444444444';
const sa = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', sb = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
test('Task 1 và lesson trả đúng mã người/lớp/bài từ chính phiên SQL, không đổi bài và không trộn hai người', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA writing_practice;
      CREATE TABLE writing_practice.activity(id bigint,slug text,title text);
      CREATE TABLE writing_practice.activity_class_scope(id bigint,public_id uuid);
      CREATE TABLE writing_practice.activity_session(id bigint,public_id uuid,activity_id bigint,activity_class_id bigint,
        student_public_id uuid,overview text,body1 text,body2 text,draft1 text,draft2 text,draft2_unlocked boolean,
        draft_version int,updated_at timestamptz,response_data jsonb);
      CREATE TABLE writing_practice.session_section(session_id bigint,section_key text,locked boolean,fail_streak int,round_number int);
      CREATE TABLE writing_practice.comment(public_id uuid,attempt_id uuid,session_id bigint,section_key text,comment_number int,status text,content text,created_at timestamptz);
      CREATE TABLE writing_practice.check_attempt(id uuid,public_id uuid,session_id bigint,section_key text,comment_number int,status text,
        result_status text,error_code text,result_artifacts jsonb,retry_count int,created_at timestamptz,completed_at timestamptz);
      CREATE TABLE writing_practice.activity_section_definition(activity_id bigint,section_key text,title text,sort_order int,
        input_fields jsonb,context_fields jsonb,required_fields jsonb,validation_mode text,prerequisite_sections jsonb);
      INSERT INTO writing_practice.activity VALUES(1,'task-a','Bài A'),(2,'lesson-b','Bài B');`);
    await db.query('INSERT INTO writing_practice.activity_class_scope VALUES(10,$1),(20,$2)', [ca, cb]);
    for (const [n, session, student, c] of [[1, sa, a, 10], [2, sb, b, 20]])
      await db.query(`INSERT INTO writing_practice.activity_session VALUES($1,$2,$1,$3,$4,$5,'','','','',false,7,now(),$6)`,
        [n, session, c, student, 'Nháp ' + n, JSON.stringify({ topic_sentence: 'Ý ' + n })]);
    const pool = { query: async (sql, args) => { const r = await db.query(sql, args); return { ...r, rowCount: r.rows.length }; } };
    const task = await createWritingPracticeService({ pool }).sessionDetails(sa);
    const lesson = await createLessonPracticeService({ pool }).sessionDetails(sb);
    assert.deepEqual([task.studentRef, task.classRef, task.activitySlug, task.overview, task.draftVersion], [a, ca, 'task-a', 'Nháp 1', 7]);
    assert.deepEqual([lesson.studentRef, lesson.classRef, lesson.activitySlug, lesson.responses.topic_sentence, lesson.draftVersion], [b, cb, 'lesson-b', 'Ý 2', 7]);
    assert.deepEqual((await db.query('SELECT count(*)::int AS n FROM writing_practice.activity_session')).rows, [{ n: 2 }]);
    await assert.rejects(createWritingPracticeService({ pool }).sessionDetails('cccccccc-cccc-4ccc-8ccc-cccccccccccc'), e => e.code === 'SESSION_NOT_FOUND');
  } finally { await db.close(); }
});
