import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('authority honors dedicated class grants while preserving identity and legacy scope checks', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE SCHEMA mapping; CREATE SCHEMA writing_practice; CREATE SCHEMA task1_bridge;
      CREATE TABLE mapping.reviewer_account(email text PRIMARY KEY,google_subject text,
        role text,status text,can_access_all_classes boolean);
      CREATE TABLE mapping.reviewer_class_access(reviewer_email text,erp_course_class_id bigint);
      CREATE TABLE mapping.lark_export_teacher_assignments(payload jsonb,scope_class_ids bigint[],source_status text);
      CREATE TABLE writing_practice.activity(id bigint,grading_pool text);
      CREATE TABLE writing_practice.activity_class_scope(activity_id bigint,erp_course_class_id bigint);
      CREATE TABLE task1_bridge.reviewer_class_access(reviewer_email text REFERENCES mapping.reviewer_account(email),
        erp_course_class_id bigint,PRIMARY KEY(reviewer_email,erp_course_class_id));
      INSERT INTO mapping.reviewer_account VALUES
        ('teacher@fixture.invalid','subject','teacher','active',false),
        ('other@fixture.invalid','other-subject','teacher','active',false);
      INSERT INTO writing_practice.activity VALUES(1,'task1');
      INSERT INTO writing_practice.activity_class_scope VALUES(1,1184);
      INSERT INTO mapping.reviewer_class_access VALUES('teacher@fixture.invalid',1184);
      INSERT INTO task1_bridge.reviewer_class_access VALUES('teacher@fixture.invalid',1384);
    `);
    const file = process.env.TASK1_BRIDGE_SQL || new URL('../ops/authority-class-access.sql', import.meta.url);
    await db.exec(await fs.readFile(file, 'utf8'));
    const identity = async (email='teacher@fixture.invalid', sub='subject') =>
      (await db.query('SELECT * FROM task1_bridge.identity_grant($1,$2)', [email,sub])).rows;
    let rows=await identity();
    assert.deepEqual([...rows[0].class_ids].sort((a,b)=>a-b), [1184,1384],
      'an approved class absent from the frozen legacy database must be accessible');
    assert.equal(rows[0].role,'teacher');
    assert.equal(rows[0].can_access_all_classes,false);
    assert.deepEqual(await identity('teacher@fixture.invalid','wrong-subject'),[]);
    assert.deepEqual((await identity('other@fixture.invalid','other-subject'))[0].class_ids,[]);
    await db.exec("DELETE FROM task1_bridge.reviewer_class_access WHERE erp_course_class_id=1384");
    assert.deepEqual((await identity())[0].class_ids,[1184]);
    await db.exec("UPDATE mapping.reviewer_account SET status='disabled' WHERE email='teacher@fixture.invalid'");
    assert.deepEqual(await identity(),[]);
  } finally { await db.close(); }
});
