// Dữ liệu nhận vào: database staging và hồ sơ giả từ staging-seed.sql.
// Việc chính: chạy HTTP → dịch vụ ghép → PostgreSQL bằng đúng quyền API, thử cả thêm và cập nhật ngoại lệ.
// Kết quả: xác nhận bài làm không đổi, hai mã cùng mở một bài và hồ sơ rời hàng chờ; chỉ in cờ tổng hợp.
// Khi lỗi: trả exit code khác 0; mọi dữ liệu thử đều rollback, không chạy trên database production.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDatabasePool } from '../src/db.js';
import { createProvisionalStudentService } from '../src/provisional-service.js';
import { createWritingPracticeService } from '../src/service.js';
import { createLessonPracticeService } from '../src/lesson-service.js';

const config = loadConfig();
const pool = createDatabasePool(config);
const client = await pool.connect();
let server;
try {
  const identity = (await client.query('SELECT current_database() AS db, current_user AS role')).rows[0];
  assert.equal(identity.db, 'writing_practice_staging', 'Chỉ được kiểm thử trong database staging.');
  assert.equal(identity.role, 'writing_practice_api', 'Phải kiểm bằng quyền API, không phải admin.');
  await client.query('BEGIN');

  // Mỗi lần gọi dịch vụ có savepoint riêng: lỗi giữa chừng phải rollback thật, kể cả khi fixture còn giữ.
  let transactionNumber = 0;
  let failAudit = false;
  const transactionPool = {
    query: (sql, params) => client.query(sql, params),
    connect: async () => {
      const savepoint = 'service_' + (++transactionNumber);
      return {
        query: (sql, params) => {
          if (sql === 'BEGIN') return client.query('SAVEPOINT ' + savepoint);
          if (sql === 'COMMIT') return client.query('RELEASE SAVEPOINT ' + savepoint);
          if (sql === 'ROLLBACK') return client.query('ROLLBACK TO SAVEPOINT ' + savepoint);
          if (failAudit && /INSERT INTO writing_practice\.provisional_student_audit/.test(sql)) {
            throw new Error('Lỗi giả ở bước cuối để kiểm rollback.');
          }
          return client.query(sql, params);
        },
        release() {}
      };
    }
  };
  const provisional = createProvisionalStudentService({ pool: transactionPool, pepper: config.provisionalStudentPinPepper });
  const writing = createWritingPracticeService({ pool: transactionPool, provisionalService: provisional });
  const dashboard = createLessonPracticeService({ pool: transactionPool, provisionalService: provisional });
  const slug = 'staging-reconcile-' + randomUUID();
  const activity = (await client.query(`INSERT INTO writing_practice.activity
    (slug,content_version,manifest_checksum,title,task_prompt,prompt_record_ref,prompt_version,status,end_date)
    VALUES($1,'fixture-v1',repeat('0',64),'Bài thử ghép hồ sơ','Đề giả','fixture','v1','active',CURRENT_DATE+30)
    RETURNING id`, [slug])).rows[0];
  const scope = (await client.query(`INSERT INTO writing_practice.activity_class_scope
    (activity_id,erp_course_class_id,class_name_snapshot,end_date,status)
    VALUES($1,-903,'Lớp thử ghép khác lớp',CURRENT_DATE+30,'active') RETURNING id,public_id`, [activity.id])).rows[0];
  const officialRef = '00000000-0000-4000-8000-000000000001';
  const official = (await client.query('SELECT * FROM writing_practice.resolve_official_student($1::uuid)', [officialRef])).rows[0];
  assert.ok(official && official.display_name === 'Học viên thử nghiệm 01', 'Thiếu hồ sơ giả đã khai báo.');
  const source = await provisional.createStudent({ activitySlug: slug, classRef: scope.public_id,
    displayName: 'Hồ sơ thử ghép', pin: '2468', requestId: randomUUID(), duplicateConfirmed: false });
  const opened = await writing.openSession({ activitySlug: slug, classRef: scope.public_id,
    studentRef: source.studentRef, accessCode: '2468' });
  const original = (await client.query('SELECT to_jsonb(s) AS value FROM writing_practice.activity_session s WHERE public_id=$1', [opened.sessionRef])).rows[0].value;
  // Học viên khác trùng tên nhưng khác lớp/UUID phải giữ nguyên, không bị ghép nhầm.
  const otherScope = (await client.query(`INSERT INTO writing_practice.activity_class_scope
    (activity_id,erp_course_class_id,class_name_snapshot,end_date,status)
    VALUES($1,-904,'Lớp đối chứng',CURRENT_DATE+30,'active') RETURNING id`, [activity.id])).rows[0];
  await client.query(`INSERT INTO writing_practice.activity_roster
    (activity_class_id,student_public_id,display_name,display_alias,active)
    VALUES($1,$2,$3,$3,true)`, [otherScope.id, randomUUID(), official.display_name]);
  const otherRoster = (await client.query('SELECT to_jsonb(r) AS value FROM writing_practice.activity_roster r WHERE activity_class_id=$1', [otherScope.id])).rows;

  const app = createApp({ config, pool: transactionPool, service: writing, provisionalService: provisional,
    adminAuth: (req, _res, next) => { req.reviewer = { email: 'fixture@example.invalid', canManage: true }; next(); } });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/v1/admin/provisional-students/' + source.studentRef + '/reconcile';

  const cases = [
    { sameName: true, existingOverride: false },
    { sameName: true, existingOverride: true },
    { sameName: false, existingOverride: false },
    { sameName: false, existingOverride: true },
    { sameName: true, existingOverride: false, rollback: true }
  ];
  for (const scenario of cases) {
    await client.query('SAVEPOINT reconciliation_case');
    const displayName = scenario.sameName ? official.display_name : 'Hồ sơ thử ghép';
    await client.query(`UPDATE writing_practice.activity_roster SET display_name=$3,display_alias=$3
      WHERE activity_class_id=$1 AND student_public_id=$2`, [scope.id, source.studentRef, displayName]);
    await client.query(`UPDATE writing_practice.provisional_student SET display_name=$3,display_alias=$3
      WHERE activity_class_id=$1 AND student_public_id=$2`, [scope.id, source.studentRef, displayName]);
    if (scenario.existingOverride) {
      await client.query(`INSERT INTO writing_practice.activity_roster_override
        (activity_class_id,erp_student_contact_id,student_public_id,display_name,active,approved_by,reason)
        VALUES($1,$2,$3,'Tên thử cũ',false,'fixture@example.invalid','Fixture')`,
      [scope.id, official.erp_student_contact_id, officialRef]);
    }
    const beforeRoster = (await client.query('SELECT to_jsonb(r) AS value FROM writing_practice.activity_roster r WHERE activity_class_id=$1 ORDER BY student_public_id', [scope.id])).rows;
    const request = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ officialStudentRef: officialRef }) });
    failAudit = Boolean(scenario.rollback);
    const response = await request();
    failAudit = false;
    const result = await response.json();
    if (scenario.rollback) {
      assert.equal(response.status, 500, 'Lỗi cuối giao dịch không được báo thành công.');
      assert.deepEqual((await client.query('SELECT to_jsonb(r) AS value FROM writing_practice.activity_roster r WHERE activity_class_id=$1 ORDER BY student_public_id', [scope.id])).rows, beforeRoster);
      assert.equal((await provisional.listPending({ activitySlug: slug })).length, 1);
      for (const table of ['activity_student_alias', 'activity_roster_override']) {
        assert.equal((await client.query('SELECT count(*)::int AS n FROM writing_practice.' + table + ' WHERE activity_class_id=$1', [scope.id])).rows[0].n, 0);
      }
      assert.deepEqual((await client.query('SELECT to_jsonb(s) AS value FROM writing_practice.activity_session s WHERE public_id=$1', [opened.sessionRef])).rows[0].value, original);
      assert.deepEqual((await client.query('SELECT to_jsonb(r) AS value FROM writing_practice.activity_roster r WHERE activity_class_id=$1', [otherScope.id])).rows, otherRoster);
      await client.query('ROLLBACK TO SAVEPOINT reconciliation_case');
      continue;
    }
    assert.equal(response.status, 200, 'Ghép thất bại: ' + (result.error || response.status));
    assert.equal(result.reconciliationStatus, 'matched');
    const after = (await client.query('SELECT to_jsonb(s) AS value FROM writing_practice.activity_session s WHERE public_id=$1', [opened.sessionRef])).rows[0].value;
    assert.deepEqual(after, original, 'Ghép không được sửa nội dung hoặc định danh bài.');
    const alias = (await client.query(`SELECT canonical_student_public_id FROM writing_practice.activity_student_alias
      WHERE activity_class_id=$1 AND alias_student_public_id=$2`, [scope.id, officialRef])).rows;
    assert.deepEqual(alias, [{ canonical_student_public_id: source.studentRef }]);
    assert.equal((await provisional.listPending({ activitySlug: slug })).length, 0);
    const live = await dashboard.listLive({ activitySlug: slug, classRef: scope.public_id });
    assert.equal(live.students.length, 1);
    assert.equal(live.students[0].sessionRef, opened.sessionRef);
    assert.deepEqual((await client.query('SELECT to_jsonb(r) AS value FROM writing_practice.activity_roster r WHERE activity_class_id=$1', [otherScope.id])).rows, otherRoster);
    const retry = await request();
    assert.equal(retry.status, 409, 'Gửi lại không được tạo liên kết hay audit thứ hai.');
    assert.equal((await client.query("SELECT count(*)::int AS n FROM writing_practice.provisional_student_audit WHERE activity_class_id=$1 AND action='matched'", [scope.id])).rows[0].n, 1);
    for (const ref of [source.studentRef, officialRef]) {
      const reopened = await writing.openSession({ activitySlug: slug, classRef: scope.public_id, studentRef: ref });
      assert.equal(reopened.sessionRef, opened.sessionRef);
    }
    await client.query('ROLLBACK TO SAVEPOINT reconciliation_case');
  }
  console.log(JSON.stringify({ apiRole: true, insertPassed: true, upsertPassed: true,
    sameNamePassed: true, rollbackPassed: true, duplicateRejected: true, unrelatedStudentUnchanged: true,
    sessionUnchanged: true, oneDashboardCard: true, pendingHidden: true, bothRefsWork: true }));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
