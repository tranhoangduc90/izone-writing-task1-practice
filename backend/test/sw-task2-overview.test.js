import assert from 'node:assert/strict';
import test from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {readLesson9Overview} from '../ops/sw-task2-production/lesson9-overview.js';

test('SW overview aggregates only sessions in the requested lesson and class', async t => {
  const db = new PGlite();
  t.after(()=>db.close());
  await db.exec(`
    CREATE SCHEMA writing_practice;
    SET search_path TO writing_practice,public;
    CREATE TABLE activity(id int,slug text,status text);
    CREATE TABLE activity_class_scope(id int,activity_id int,public_id text,status text);
    CREATE TABLE activity_session(id int,activity_id int,activity_class_id int,public_id text,student_public_id text,
      updated_at timestamptz,overview text,body1 text,body2 text,draft1 text,draft2 text,response_data jsonb);
    CREATE TABLE lesson9_session_state(session_id int,ui_version text,data jsonb);
    CREATE TABLE session_section(session_id int,section_key text,locked boolean,fail_streak int);
    CREATE TABLE check_attempt(id int,session_id int,section_key text,status text,result_status text,created_at timestamptz,snapshot jsonb);
    CREATE TABLE comment(session_id int,section_key text,attempt_id int,status text,content text);
    CREATE TABLE teacher_comment_thread(id int,session_id int,status text);
    CREATE TABLE teacher_comment_message(thread_id int);
    INSERT INTO activity VALUES (1,'lesson','active'),(2,'other-lesson','active');
    INSERT INTO activity_class_scope VALUES (1,1,'class','active'),(2,1,'other','active'),
      (3,2,'different-lesson-class','active'),(4,1,'closed','inactive');
    INSERT INTO activity_session (id,activity_id,activity_class_id,public_id,student_public_id,updated_at,draft1,draft2,response_data)
    VALUES (1,1,1,'current','student','2026-11-04T00:00:00Z','private draft','revised draft',
      '{"body_choice":"body2","body2_idea1":"private idea","body2_idea2":" ","idea2_a":"private second idea"}'),
      (2,1,2,'unrelated','student',now(),null,null,'{}'),
      (3,2,3,'other-lesson','student',now(),null,null,'{}'),
      (4,1,1,'historical','older student',now(),null,null,'{"idea2_a":"legacy"}'),
      (5,1,4,'closed','student',now(),null,null,'{}');
    INSERT INTO lesson9_session_state VALUES (1,'sw-task2-lesson9-v1',
      '{"idea2Opened":true,"editedFields":["idea1_a"],"approvals":{"topic_sentence":{"private":"approval text"},"draft":null}}');
    INSERT INTO session_section VALUES (1,'topic_sentence',false,3),(1,'supporting_idea_1',false,0),
      (1,'supporting_idea_2',false,0),(1,'draft',true,0);
    INSERT INTO check_attempt VALUES
      (1,1,'topic_sentence','completed','needs_revision','2026-11-04T00:00:01Z','{}'),
      (2,1,'topic_sentence','completed','passed','2026-11-04T00:00:02Z','{}'),
      (3,1,'supporting_idea_1','failed',null,'2026-11-04T00:00:03Z','{}'),
      (4,1,'supporting_idea_2','leased',null,'2026-11-04T00:00:04Z','{}'),
      (5,1,'draft','completed','passed','2026-11-04T00:00:05Z','{"draft1":"private draft","draft2":"before edits"}'),
      (6,2,'draft','completed','passed','2026-11-04T00:00:05Z','{}');
    INSERT INTO comment VALUES (1,'topic_sentence',1,'pending','private feedback'),
      (1,'topic_sentence',2,'pending','Học viên tự xác nhận'),
      (1,'draft',5,'pending','private draft feedback');
    INSERT INTO teacher_comment_thread VALUES (1,1,'open'),(2,1,'addressed'),(3,2,'open'),(4,1,'open');
    INSERT INTO teacher_comment_message VALUES (1),(1),(2),(3);
  `);
  let reads=0;
  const pool={query(...args){reads++;return db.query(...args);}};
  const students=await readLesson9Overview(pool,'lesson','class');
  assert.equal(reads,1);
  assert.deepEqual(students.map(row=>row.sessionRef).sort(),['current','historical']);
  const row=students.find(row=>row.sessionRef==='current');
  assert.deepEqual(row.steps,{
    topic_sentence:{status:'revision',locked:false,checks:2,negatives:1,ai:1},
    supporting_idea_1:{status:'technical_error',locked:false,checks:0,negatives:0,ai:0},
    supporting_idea_2:{status:'pending',locked:false,checks:0,negatives:0,ai:0},
    draft:{status:'passed',locked:true,checks:1,negatives:0,ai:1},
  });
  assert.deepEqual(row.responses,{body_choice:'body2',body2_idea1:'x',body2_idea2:' ',idea2_a:'x',draft1:'x',draft2:'x'});
  assert.equal(row.openThreads,1);
  assert.equal(row.draftEdited,true);
  assert.equal(row.idea2Open,true);
  assert.deepEqual(row.approvals,['topic_sentence']);
  assert.deepEqual(row.editedFields,['idea1_a']);
  assert.equal(students.find(row=>row.sessionRef==='historical').idea2Open,true);
  assert.doesNotMatch(JSON.stringify(students),/private|revised draft|before edits/);
  assert.deepEqual(await readLesson9Overview(pool,'other-lesson','class'),[]);
  assert.deepEqual(await readLesson9Overview(pool,'lesson','closed'),[]);
});
