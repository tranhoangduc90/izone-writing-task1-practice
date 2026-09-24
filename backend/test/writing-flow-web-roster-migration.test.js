import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const migrationUrl = new URL(
  '../../docs/migrations/2026-09-24-writing-flow-web-substitute-roster-v16.sql',
  import.meta.url,
);

// Dữ liệu vào: roster giả hai cohort trong PostgreSQL thử nghiệm, không có tên thật.
// Việc chính: chạy migration và truy vấn đúng quyền của API Writing.
// Kết quả: cờ mở mặc định đóng, tên duy nhất nhận đúng mã ERP, tên trùng bị chặn.
// Khi lỗi: test chỉ hiện mã lỗi kỹ thuật; không chạm production.
test('tra roster Substitute bằng quyền tối thiểu, không phụ thuộc Classroom', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE writing_practice_api;
      CREATE ROLE web_guest;
      CREATE SCHEMA writing_flow;
      CREATE SCHEMA assessment;
      CREATE SCHEMA assessment_k56;
      CREATE TABLE writing_flow.pair (pair_id uuid PRIMARY KEY);
      CREATE TABLE assessment.term_test_roster (
        test_slug text NOT NULL, erp_course_class_id bigint NOT NULL,
        erp_student_contact_id bigint NOT NULL, student_ref uuid NOT NULL,
        student_name_snapshot text NOT NULL
      );
      CREATE TABLE assessment_k56.term_test_roster (
        test_slug text NOT NULL, erp_course_class_id bigint NOT NULL,
        erp_student_contact_id bigint NOT NULL, student_ref uuid NOT NULL,
        student_name_snapshot text NOT NULL, is_eligible boolean NOT NULL
      );
      INSERT INTO assessment_k56.term_test_roster VALUES
        ('term-test-1-k56',1252,1001,'11111111-1111-4111-8111-111111111111','Học viên Một',true),
        ('term-test-2-k56',1252,1001,'22222222-2222-4222-8222-222222222222','Học viên Một',true),
        ('term-test-1-k56',1252,1003,'33333333-3333-4333-8333-333333333333','Học viên Trùng',true),
        ('term-test-1-k56',1252,1004,'44444444-4444-4444-8444-444444444444','Học viên Trùng',true),
        ('term-test-1-k56',1252,1005,'55555555-5555-4555-8555-555555555555','Học viên Rời',false);
      INSERT INTO assessment.term_test_roster VALUES
        ('term-test-1',2207,2001,'66666666-6666-4666-8666-666666666666','Học viên Hai');
      GRANT USAGE ON SCHEMA writing_flow TO writing_practice_api;
      GRANT USAGE ON SCHEMA writing_flow TO web_guest;
    `);
    const migration = await readFile(migrationUrl, 'utf8');
    await db.exec(migration);
    await db.exec(migration);

    const closed = await db.query(`SELECT enabled FROM writing_flow.web_substitute_access`);
    assert.equal(closed.rows.length, 0);
    await db.exec(`SET ROLE writing_practice_api;`);
    await assert.rejects(db.query(`SELECT count(*) FROM assessment_k56.term_test_roster`),
      /permission denied/u);
    await assert.rejects(db.query(`UPDATE writing_flow.web_substitute_access
      SET enabled=true WHERE erp_course_class_id=1252`), /permission denied/u);
    await assert.rejects(db.query(`SELECT * FROM writing_flow.resolve_web_substitute_student(
      'substitute-test-2-k56',1252,'Học viên Một')`), /WEB_TEST_ACCESS_CLOSED/u);
    await db.exec(`RESET ROLE;`);

    await db.exec(`INSERT INTO writing_flow.web_substitute_access
      (test_slug,cohort,erp_course_class_id) VALUES
      ('substitute-test-2-k56',56,1252),
      ('substitute-test-1-k67',67,2207);`);
    const defaultClosed = await db.query(`SELECT bool_and(enabled = false) AS all_closed
      FROM writing_flow.web_substitute_access`);
    assert.equal(defaultClosed.rows[0].all_closed, true);
    await assert.rejects(db.exec(`UPDATE writing_flow.web_substitute_access
      SET enabled=true;`), /web_substitute_access_rubric_check/u);
    await db.exec(`UPDATE writing_flow.web_substitute_access
      SET rubric_version='test-rubric-v1', enabled=true;`);
    await db.exec(`SET ROLE writing_practice_api;`);

    const k56 = await db.query(`SELECT * FROM writing_flow.resolve_web_substitute_student(
      'substitute-test-2-k56',1252,'  Học   viên Một  ')`);
    assert.equal(k56.rows.length, 1);
    assert.equal(Number(k56.rows[0].cohort), 56);
    assert.equal(Number(k56.rows[0].erp_student_contact_id), 1001);
    assert.equal(k56.rows[0].rubric_version, 'test-rubric-v1');
    const k67 = await db.query(`SELECT * FROM writing_flow.resolve_web_substitute_student(
      'substitute-test-1-k67',2207,'Học viên Hai')`);
    assert.equal(Number(k67.rows[0].erp_student_contact_id), 2001);

    await assert.rejects(db.query(`SELECT * FROM writing_flow.resolve_web_substitute_student(
      'substitute-test-2-k56',1252,'Học viên Trùng')`), /WEB_ROSTER_NAME_AMBIGUOUS/u);
    await assert.rejects(db.query(`SELECT * FROM writing_flow.resolve_web_substitute_student(
      'substitute-test-2-k56',1252,'Học viên Rời')`), /WEB_ROSTER_NAME_NOT_FOUND/u);
    await assert.rejects(db.query(`SELECT * FROM writing_flow.resolve_web_substitute_student(
      'substitute-test-2-k56',2207,'Học viên Hai')`), /WEB_TEST_ACCESS_CLOSED/u);
    await assert.rejects(db.query(`SELECT * FROM writing_flow.resolve_web_substitute_student(
      'substitute-test-1-k56',1252,'Học viên Một')`), /WEB_TEST_ACCESS_CLOSED/u);
    await db.exec(`RESET ROLE;`);

    await db.exec(`SET ROLE web_guest;`);
    await assert.rejects(db.query(`SELECT * FROM writing_flow.resolve_web_substitute_student(
      'substitute-test-2-k56',1252,'Học viên Một')`), /permission denied/u);
    await db.exec(`RESET ROLE;`);

    const unchanged = await db.query(`SELECT
      (SELECT count(*)::int FROM assessment_k56.term_test_roster) AS k56,
      (SELECT count(*)::int FROM assessment.term_test_roster) AS k67`);
    assert.deepEqual(unchanged.rows[0], { k56: 5, k67: 1 });

    const intakeMigration = await readFile(new URL(
      '../../docs/migrations/2026-09-24-writing-flow-web-substitute-intake-v17.sql',
      import.meta.url,
    ), 'utf8');
    await db.exec(intakeMigration);
    await db.exec(intakeMigration);
    await db.exec(`SET ROLE writing_practice_api;`);
    const issued = await db.query(`INSERT INTO writing_flow.web_substitute_attempt
      (test_slug,cohort,erp_course_class_id,erp_student_contact_id,task_number,rubric_version)
      VALUES ('substitute-test-2-k56',56,1252,1001,1,'test-rubric-v1')
      RETURNING attempt_id,status`);
    const attemptId = issued.rows[0].attempt_id;
    assert.match(attemptId, /^[0-9a-f-]{36}$/u);
    assert.equal(issued.rows[0].status, 'open');
    await assert.rejects(db.query(`INSERT INTO writing_flow.web_substitute_attempt
      (test_slug,cohort,erp_course_class_id,erp_student_contact_id,task_number,rubric_version)
      VALUES ('substitute-test-2-k56',56,1252,1001,1,'test-rubric-v1')`), /duplicate key/u);
    await assert.rejects(db.query(`UPDATE writing_flow.web_substitute_attempt
      SET erp_student_contact_id=1002 WHERE attempt_id=$1`, [attemptId]),
    /permission denied/u);
    await assert.rejects(db.query(`INSERT INTO writing_flow.web_substitute_submission
      (attempt_id,task_number,content_ciphertext,content_sha256,prompt_sha256)
      VALUES ($1,2,decode('abcd','hex'),repeat('a',64),repeat('b',64))`, [attemptId]),
    /foreign key/u);
    const receipt = await db.query(`INSERT INTO writing_flow.web_substitute_submission
      (attempt_id,task_number,content_ciphertext,content_sha256,prompt_sha256)
      VALUES ($1,1,decode('abcd','hex'),repeat('a',64),repeat('b',64))
      RETURNING submission_id,run_key,status`, [attemptId]);
    assert.match(receipt.rows[0].submission_id, /^[0-9a-f-]{36}$/u);
    assert.match(receipt.rows[0].run_key, /^[0-9a-f-]{36}$/u);
    assert.equal(receipt.rows[0].status, 'pending');
    await assert.rejects(db.query(`INSERT INTO writing_flow.web_substitute_submission
      (attempt_id,task_number,content_ciphertext,content_sha256,prompt_sha256)
      VALUES ($1,1,decode('abce','hex'),repeat('c',64),repeat('b',64))`, [attemptId]),
    /duplicate key/u);
    await assert.rejects(db.query(`UPDATE writing_flow.web_substitute_submission
      SET content_ciphertext=decode('abce','hex') WHERE attempt_id=$1`, [attemptId]),
    /permission denied/u);
    await assert.rejects(db.query(`UPDATE writing_flow.web_substitute_submission
      SET status='running' WHERE attempt_id=$1`, [attemptId]),
    /web_substitute_submission_lease_check/u);
    await assert.rejects(db.query(`UPDATE writing_flow.web_substitute_submission
      SET status='completed' WHERE attempt_id=$1`, [attemptId]),
    /web_substitute_submission_result_check/u);
    const running = await db.query(`UPDATE writing_flow.web_substitute_submission
      SET status='running',attempt_count=1,
        lease_token='77777777-7777-4777-8777-777777777777',
        lease_expires_at=now()+interval '30 minutes'
      WHERE attempt_id=$1 RETURNING status,attempt_count`, [attemptId]);
    assert.equal(running.rows[0].status, 'running');
    assert.equal(running.rows[0].attempt_count, 1);
    const completed = await db.query(`UPDATE writing_flow.web_substitute_submission
      SET status='completed',lease_token=NULL,lease_expires_at=NULL,
        result_ciphertext=decode('abcd','hex'),result_sha256=repeat('c',64),
        task_score=6.5,completed_at=now()
      WHERE attempt_id=$1 RETURNING status,task_score`, [attemptId]);
    assert.equal(completed.rows[0].status, 'completed');
    assert.equal(Number(completed.rows[0].task_score), 6.5);
    await db.exec(`RESET ROLE;`);
  } finally {
    await db.close();
  }
});
