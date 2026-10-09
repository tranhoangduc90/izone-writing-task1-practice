// Nhận vào: snapshot phân công cũ vẫn ghi đang học, nhưng ERP đã xác minh hoàn thành.
// Kiểm SQL đọc lớp thật: dashboard và đồng bộ không được bật lớp đó lại từ snapshot cũ.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
const { createWritingFlowService } = await import(process.env.WRITING_SERVICE_MODULE
  || '../src/writing-flow-service.js');

test('trạng thái ERP có nhật ký đúng ID thắng snapshot phân công cũ, giữ các lớp khác', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA mapping;CREATE SCHEMA writing_flow;
      CREATE TABLE mapping.classroom_course_mapping(erp_course_class_id bigint,
        erp_class_name_snapshot text,classroom_course_id text,classroom_course_name_snapshot text,
        classroom_section_snapshot text,status text,updated_at timestamptz DEFAULT now());
      CREATE TABLE mapping.reviewer_class_access(erp_course_class_id bigint,reviewer_email text,class_status_snapshot text);
      CREATE TABLE mapping.reviewer_account(email text,display_name text,status text);
      CREATE TABLE mapping.classroom_direct_class(class_code text,class_name_snapshot text,
        classroom_course_id text,classroom_course_name_snapshot text,classroom_section_snapshot text,
        status text,updated_at timestamptz,class_status text);
      CREATE TABLE writing_flow.class_registry(class_code text,scan_status text,scan_attempt_count integer,
        last_scan_at timestamptz,next_scan_at timestamptz,last_error_code text,updated_at timestamptz);
      CREATE TABLE writing_flow.operator_event(event_id integer,event_type text,after_state jsonb,created_at timestamptz);
      INSERT INTO mapping.classroom_course_mapping(erp_course_class_id,erp_class_name_snapshot,
        classroom_course_id,classroom_section_snapshot,status) VALUES
        (1180,'IC2195','course-old','Chiến lược (5.0 - 6.0)','approved'),
        (1182,'IC2197','course-other','Chiến lược (5.0 - 6.0)','approved');
      INSERT INTO mapping.reviewer_class_access VALUES(1180,'teacher','on_going'),(1182,'teacher','on_going');
      INSERT INTO mapping.reviewer_account VALUES('teacher','Giảng viên mẫu','active');
      INSERT INTO writing_flow.operator_event VALUES(1,'class_mapping_changed',
        '{"erpStatusVerified":true,"erpCourseClassId":"1180","classStatus":"completed"}',now());`);
    const service = createWritingFlowService({ pool: { query: (...args) => db.query(...args) } });
    assert.deepEqual((await service.listClasses({ view: 'completed' })).map(r => r.class_code),['IC2195']);
    assert.deepEqual((await service.listClasses({ view: 'active' })).map(r => r.class_code),['IC2197']);
    // Một sự kiện đồng bộ thông thường không giả được xác minh trực tiếp ERP.
    await db.exec(`INSERT INTO writing_flow.operator_event VALUES(2,'class_mapping_changed',
      '{"erpCourseClassId":"1180","classStatus":"on_going"}',now()+interval '1 second');`);
    assert.deepEqual((await service.listClasses({ view: 'completed' })).map(r => r.class_code),['IC2195']);
    // Xác minh đang học hôm nay không khóa lớp ở trạng thái đó mãi mãi:
    // nguồn mapping đổi sang hoàn thành ngày sau vẫn được tiếp nhận.
    await db.exec(`INSERT INTO writing_flow.operator_event VALUES(3,'class_mapping_changed',
      '{"erpStatusVerified":true,"erpCourseClassId":"1182","classStatus":"on_going"}',now());
      UPDATE mapping.reviewer_class_access SET class_status_snapshot='completed' WHERE erp_course_class_id=1182;`);
    assert.deepEqual((await service.listClasses({ view: 'completed' })).map(r => r.class_code),['IC2195','IC2197']);
  } finally { await db.close(); }
});
