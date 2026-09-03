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

  // Gói mọi transaction nội bộ trong một transaction ngoài duy nhất để luôn hoàn tác fixture.
  const transactionPool = {
    query: (sql, params) => client.query(sql, params),
    connect: async () => ({
      query: (sql, params) => ['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)
        ? Promise.resolve({ rows: [], rowCount: 0 }) : client.query(sql, params),
      release() {}
    })
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

  const app = createApp({ config, pool: transactionPool, service: writing, provisionalService: provisional,
    adminAuth: (req, _res, next) => { req.reviewer = { email: 'fixture@example.invalid', canManage: true }; next(); } });
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = 'http://127.0.0.1:' + server.address().port + '/api/v1/admin/provisional-students/' + source.studentRef + '/reconcile';

  for (const existingOverride of [false, true]) {
    await client.query('SAVEPOINT reconciliation_case');
    if (existingOverride) {
      await client.query(`INSERT INTO writing_practice.activity_roster_override
        (activity_class_id,erp_student_contact_id,student_public_id,display_name,active,approved_by,reason)
        VALUES($1,$2,$3,'Tên thử cũ',false,'fixture@example.invalid','Fixture')`,
      [scope.id, official.erp_student_contact_id, officialRef]);
    }
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ officialStudentRef: officialRef }) });
    const result = await response.json();
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
    for (const ref of [source.studentRef, officialRef]) {
      const reopened = await writing.openSession({ activitySlug: slug, classRef: scope.public_id, studentRef: ref });
      assert.equal(reopened.sessionRef, opened.sessionRef);
    }
    await client.query('ROLLBACK TO SAVEPOINT reconciliation_case');
  }
  console.log(JSON.stringify({ apiRole: true, insertPassed: true, upsertPassed: true,
    sessionUnchanged: true, oneDashboardCard: true, pendingHidden: true, bothRefsWork: true }));
} finally {
  if (server) await new Promise(resolve => server.close(resolve));
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
}
