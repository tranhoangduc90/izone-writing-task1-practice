// Dữ liệu giả: kiểm SQL thật, đầu ra ERP và số lượt quét nhật ký qua public service.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createWritingFlowService } from '../src/writing-flow-service.js';

async function fixture() {
  const db = new PGlite();
  await db.exec(`CREATE SCHEMA mapping; CREATE SCHEMA writing_flow;
    CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint,
      erp_class_name_snapshot text,classroom_course_id text,classroom_course_name_snapshot text,
      classroom_section_snapshot text,status text,updated_at timestamptz DEFAULT '2026-10-01T00:00:00Z');
    CREATE TABLE mapping.reviewer_class_access(erp_course_class_id bigint,reviewer_email text,class_status_snapshot text);
    CREATE TABLE mapping.reviewer_account(email text,display_name text,status text);
    CREATE TABLE mapping.classroom_direct_class(class_code text,class_name_snapshot text,
      classroom_course_id text,classroom_course_name_snapshot text,classroom_section_snapshot text,
      status text,updated_at timestamptz,class_status text);
    CREATE TABLE writing_flow.class_registry(class_code text PRIMARY KEY,classroom_course_id text,
      classroom_name text,cohort text,teacher_names text[],enabled boolean,source_ref text,
      erp_course_class_id bigint,mapping_status text,class_status text,eligibility_reason text,
      scan_status text,scan_attempt_count integer DEFAULT 0,last_scan_at timestamptz,
      next_scan_at timestamptz,last_error_code text,last_mapping_sync_at timestamptz,updated_at timestamptz);
    CREATE TABLE writing_flow.operator_event(event_id bigserial PRIMARY KEY,event_type text,
      class_code text,actor_ref text,request_id uuid,reason text,before_state jsonb,after_state jsonb,
      created_at timestamptz DEFAULT now());
    INSERT INTO mapping.reviewer_account VALUES ('teacher@example.invalid','Giảng viên mẫu','active');
    INSERT INTO mapping.classroom_course_mapping(erp_course_class_id,erp_class_name_snapshot,
      classroom_course_id,classroom_course_name_snapshot,classroom_section_snapshot,status)
      SELECT n,'IC'||(2200+n),'course-'||n,'Lớp mẫu '||n,'Chiến lược (5.0 - 6.0)','approved'
      FROM generate_series(101,108) n;
    INSERT INTO mapping.reviewer_class_access
      SELECT n,'teacher@example.invalid',CASE WHEN n=103 THEN 'completed' ELSE 'on_going' END
      FROM generate_series(101,108) n;
    INSERT INTO mapping.reviewer_class_access VALUES (104,'teacher@example.invalid','completed');
    INSERT INTO mapping.classroom_course_mapping(erp_course_class_id,erp_class_name_snapshot,
      classroom_course_id,classroom_section_snapshot,status)
      VALUES (109,'IC2288','course-excluded','Chiến lược (5.0 - 6.0)','approved');
    INSERT INTO mapping.reviewer_class_access VALUES (109,'teacher@example.invalid','on_going');
    INSERT INTO mapping.classroom_direct_class VALUES ('Term test 1 khóa Chiến lược',
      'Term test 1 khóa Chiến lược','course-direct','Lớp trực tiếp','',
      'approved','2026-10-01T00:00:00Z','on_going');
    INSERT INTO writing_flow.operator_event(event_type,after_state,created_at) VALUES
      ('class_mapping_changed','{"erpCourseClassId":"101","erpStatusVerified":true,"classStatus":"completed"}','2026-10-01T00:00:00Z'),
      ('class_mapping_changed','{"erpCourseClassId":"101","classStatus":"on_going"}','2026-10-02T00:00:00Z'),
      ('other_event','{"erpCourseClassId":"101","erpStatusVerified":true,"classStatus":"on_going"}','2026-10-03T00:00:00Z'),
      ('class_mapping_changed','{"erpCourseClassId":"102","erpStatusVerified":true,"classStatus":"completed"}','2026-10-01T00:00:00Z'),
      ('class_mapping_changed','{"erpCourseClassId":"102","erpStatusVerified":true,"classStatus":"on_going"}','2026-10-01T00:00:00Z'),
      ('class_mapping_changed','{"erpCourseClassId":"103","erpStatusVerified":true,"classStatus":"on_going"}','2026-10-01T00:00:00Z'),
      ('class_mapping_changed','{"erpCourseClassId":"105","erpStatusVerified":true,"classStatus":"completed"}','2026-10-01T00:00:00Z'),
      ('class_mapping_changed','{"erpCourseClassId":"107","erpStatusVerified":false,"classStatus":"completed"}','2026-10-01T00:00:00Z'),
      ('class_mapping_changed','{"erpStatusVerified":true,"classStatus":"completed"}','2026-10-01T00:00:00Z'),
      ('class_mapping_changed','{"erpCourseClassId":"108","erpStatusVerified":true,"classStatus":"completed"}','2026-10-03T00:00:00Z'),
      ('class_mapping_changed','{"erpCourseClassId":"108","erpStatusVerified":true,"classStatus":"on_going"}','2026-10-02T00:00:00Z');`);
  const queries = [];
  const client = { async query(sql, values) {
    queries.push(sql);
    const result = await db.query(sql, values);
    return { ...result,rowCount: result.rows.length || result.affectedRows || 0 };
  }, release() {} };
  const pool = { query: (...args) => client.query(...args), connect: async () => client };
  return { db,queries,service:createWritingFlowService({ pool }) };
}

function normalizeRows(rows) {
  return rows.map(row => ({ ...row,class_statuses:[...row.class_statuses].sort(),
    teacher_names:[...row.teacher_names].sort() }));
}

function scans(node, relation, result = []) {
  if (node['Relation Name'] === relation) result.push(node);
  for (const child of node.Plans || []) scans(child, relation, result);
  return result;
}

test('đọc mapping giữ nghĩa ERP, direct, loại lớp và consumer đồng bộ', async t => {
  const { db,queries,service } = await fixture();
  try {
    const classes = await service.listClasses({ view:'all' });
    const currentSql = queries[0];
    const originalSql = await readFile(new URL('./fixtures/writing-flow-mapping-original.sql',import.meta.url),'utf8');
    assert.deepEqual(normalizeRows((await db.query(currentSql)).rows),
      normalizeRows((await db.query(originalSql)).rows),'Toàn bộ hàng SQL gốc/sửa phải bằng nhau');
    const byCode = new Map(classes.map(row => [row.class_code,row]));
    assert.equal(byCode.get('IC2301').operational_state,'completed','Sự kiện mới chưa kiểm không thắng ERP');
    assert.equal(byCode.get('IC2302').operational_state,'active','event_id quyết định khi trùng created_at');
    assert.equal(byCode.get('IC2303').operational_state,'completed','ERP ongoing không khóa nguồn completed');
    assert.equal(byCode.get('IC2304').operational_state,'status_review','Giữ trạng thái mâu thuẫn');
    assert.equal(byCode.get('IC2305').operational_state,'completed');
    assert.equal(byCode.get('IC2306').operational_state,'active','Không có sự kiện vẫn dùng phân công');
    assert.equal(byCode.get('IC2307').operational_state,'active','Sự kiện chưa xác minh không override');
    assert.equal(byCode.get('IC2308').operational_state,'completed','created_at thắng event_id mới hơn');
    assert.equal(byCode.get('Term test 1 khóa Chiến lược').enabled,true);
    assert.equal(byCode.has('IC2288'),false);
    const coverage = await service.listClassCoverage();
    assert.ok(coverage.some(row => row.class_code==='IC2301'));
    assert.equal(coverage.some(row => row.class_code==='IC2288'),false);
    const result = await service.syncClassesFromMapping();
    assert.equal(result.received,10);
    const registry = (await db.query('SELECT * FROM writing_flow.class_registry')).rows;
    const completed = registry.find(row => row.class_code==='IC2301');
    assert.equal(completed.enabled,false);
    assert.equal(completed.scan_status,'paused');
    assert.equal(completed.class_status,'completed');
    assert.equal(registry.find(row => row.class_code==='IC2306').enabled,true);
    assert.equal(registry.find(row => row.class_code==='IC2288').enabled,false);
    await t.test('nhiều lớp chỉ đọc tập nhật ký một lần, không quét lại từng lớp', async () => {
      await db.exec(`INSERT INTO mapping.classroom_course_mapping(erp_course_class_id,erp_class_name_snapshot,
          classroom_course_id,classroom_section_snapshot,status)
          SELECT n,'IC'||(2200+n),'course-'||n,'Chiến lược (5.0 - 6.0)','approved'
          FROM generate_series(110,360) n;
        INSERT INTO writing_flow.operator_event(event_type,after_state)
          SELECT 'class_mapping_changed',jsonb_build_object('erpCourseClassId',(110+n%251)::text,
            'erpStatusVerified',true,'classStatus','completed') FROM generate_series(1,2510) n;
        ANALYZE mapping.classroom_course_mapping; ANALYZE writing_flow.operator_event;`);
      const plan = (await db.query('EXPLAIN (ANALYZE,FORMAT JSON) '+currentSql)).rows[0]['QUERY PLAN'][0].Plan;
      const eventScans = scans(plan,'operator_event');
      assert.ok(eventScans.length>0,'EXPLAIN phải chứa nhật ký thực');
      assert.ok(eventScans.every(node => node['Actual Loops']<=1),
        'Không được quét toàn operator_event lại cho từng lớp: '+JSON.stringify(eventScans.map(n=>n['Actual Loops'])));
    });
  } finally { await db.close(); }
});
