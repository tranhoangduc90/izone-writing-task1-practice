import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { WEB_SUBSTITUTE_REGISTRY } from '../src/writing-flow-web-registry.js';

const fixture = await readFile(new URL(
  '../integration/staging-substitute-roster.sql', import.meta.url), 'utf8');
const rosterMigration = await readFile(new URL(
  '../../docs/migrations/2026-09-24-writing-flow-web-substitute-roster-v16.sql',
  import.meta.url), 'utf8');
const accessSeed = await readFile(new URL(
  '../integration/staging-substitute-access.sql', import.meta.url), 'utf8');
const rollback = await readFile(new URL(
  '../integration/staging-substitute-rollback.sql', import.meta.url), 'utf8');
const intakeMigration = await readFile(new URL(
  '../../docs/migrations/2026-09-24-writing-flow-web-substitute-intake-v17.sql',
  import.meta.url), 'utf8');
const portalMigration = await readFile(new URL(
  '../../docs/migrations/2026-09-24-writing-flow-web-substitute-portal-v18.sql',
  import.meta.url), 'utf8');

// Dữ liệu vào: kho PostgreSQL cục bộ rỗng, không kết nối VPS.
// Việc chính: kiểm chốt database, rollback khi trùng schema và roster giả qua hàm v16.
// Kết quả: chỉ hai dòng giả, không quyền đọc roster trực tiếp cho API.
// Khi lỗi: test đỏ; không có dữ liệu học viên thật hoặc thao tác staging/production.
test('roster staging chỉ tạo khi kho và schema đúng, tra tên giả qua v16', async () => {
  const db = new PGlite();
  try {
    await db.exec('CREATE ROLE writing_practice_api;');
    const { rows } = await db.query('SELECT current_database() AS db_name');
    const localFixture = fixture.replace("'writing_practice_staging'",
      `'${rows[0].db_name}'`);
    await assert.rejects(db.exec(fixture), /WEB_STAGING_DATABASE_REQUIRED/u);
    await db.exec('ROLLBACK;');
    await assert.rejects(db.exec(localFixture), /WEB_STAGING_WRITING_FLOW_REQUIRED/u);
    await db.exec('ROLLBACK;');
    await db.exec(`CREATE SCHEMA writing_flow;
      CREATE TABLE writing_flow.keep_me (id integer PRIMARY KEY);
      GRANT USAGE ON SCHEMA writing_flow TO writing_practice_api;`);
    await db.exec(localFixture);
    await assert.rejects(db.exec(localFixture), /WEB_STAGING_ROSTER_ALREADY_EXISTS/u);
    await db.exec('ROLLBACK;');
    const count = await db.query(`SELECT
      (SELECT count(*)::int FROM assessment.term_test_roster) AS k67,
      (SELECT count(*)::int FROM assessment_k56.term_test_roster) AS k56`);
    assert.deepEqual(count.rows[0], { k67: 1, k56: 1 });
    await db.exec(rosterMigration);
    const localSeed = accessSeed.replace("'writing_practice_staging'",
      `'${rows[0].db_name}'`);
    await assert.rejects(db.exec(accessSeed), /WEB_STAGING_DATABASE_REQUIRED/u);
    await db.exec('ROLLBACK;');
    await db.exec(localSeed);
    await assert.rejects(db.exec(localSeed), /WEB_STAGING_ACCESS_ALREADY_EXISTS/u);
    await db.exec('ROLLBACK;');
    const access = await db.query(`SELECT test_slug, rubric_version, enabled
      FROM writing_flow.web_substitute_access ORDER BY test_slug`);
    assert.equal(access.rows.length, 4);
    for (const row of access.rows) {
      assert.equal(row.enabled, true);
      assert.equal(row.rubric_version, WEB_SUBSTITUTE_REGISTRY[row.test_slug].rubricVersion);
    }
    await db.exec('SET ROLE writing_practice_api;');
    await assert.rejects(db.query('SELECT * FROM assessment_k56.term_test_roster'),
      /permission denied/u);
    const k56 = await db.query(`SELECT erp_student_contact_id
      FROM writing_flow.resolve_web_substitute_student(
        'substitute-test-2-k56', 990056001, 'Học viên giả khóa 56')`);
    const k67 = await db.query(`SELECT erp_student_contact_id
      FROM writing_flow.resolve_web_substitute_student(
        'substitute-test-1-k67', 990067001, 'Học viên giả khóa 67')`);
    assert.equal(Number(k56.rows[0].erp_student_contact_id), 990056101);
    assert.equal(Number(k67.rows[0].erp_student_contact_id), 990067101);
    await assert.rejects(db.query(`SELECT *
      FROM writing_flow.resolve_web_substitute_student(
        'substitute-test-2-k56', 990056001, 'Học viên giả khóa 67')`),
    /WEB_ROSTER_NAME_NOT_FOUND/u);
    await db.exec('RESET ROLE;');
    await db.exec(intakeMigration);
    await db.exec(portalMigration);
    const localRollback = rollback.replace("'writing_practice_staging'",
      `'${rows[0].db_name}'`);
    await assert.rejects(db.exec(rollback), /WEB_STAGING_DATABASE_REQUIRED/u);
    await db.exec('ROLLBACK;');
    await db.exec(`INSERT INTO writing_flow.web_substitute_access
      (test_slug, cohort, erp_course_class_id)
      VALUES ('substitute-test-1-k56', 56, 1234);`);
    await assert.rejects(db.exec(localRollback),
      /WEB_STAGING_ROLLBACK_SCOPE_MISMATCH/u);
    await db.exec('ROLLBACK;');
    const preserved = await db.query(`SELECT count(*)::int AS n
      FROM writing_flow.web_substitute_access`);
    assert.equal(preserved.rows[0].n, 5);
    await db.exec(`DELETE FROM writing_flow.web_substitute_access
      WHERE erp_course_class_id = 1234;`);
    await db.exec(localRollback);
    const readback = await db.query(`SELECT
      to_regnamespace('assessment') IS NULL AS assessment_removed,
      to_regnamespace('assessment_k56') IS NULL AS k56_removed,
      to_regclass('writing_flow.web_substitute_access') IS NULL AS access_removed,
      to_regclass('writing_flow.web_substitute_attempt') IS NULL AS attempt_removed,
      to_regclass('writing_flow.keep_me') IS NOT NULL AS unrelated_kept`);
    assert.deepEqual(readback.rows[0], {
      assessment_removed: true, k56_removed: true, access_removed: true,
      attempt_removed: true, unrelated_kept: true,
    });
  } finally {
    await db.close();
  }
});
