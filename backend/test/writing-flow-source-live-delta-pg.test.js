// Nhận vào: một nguồn Classroom giả đã đọc xong, có kết luận riêng của reader.
// Việc chính: chạy SQL upsert thật, kiểm quét lặp giữ kết luận và không xếp lại hàng.
// Kết quả: dữ liệu gốc đổi mới đưa nguồn về pending; không gọi hệ thống ngoài.
import assert from 'node:assert/strict';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createWritingFlowOperations } from '../src/writing-flow-operations.js';

test('giữ live: quét Classroom lặp không xóa kết luận reader hoặc xếp nguồn lại', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA writing_flow;
      CREATE TABLE writing_flow.source_record (
        source_id uuid DEFAULT '11111111-1111-4111-8111-111111111111',
        source_type text,source_app_id text,source_table_id text,source_record_id text,
        homework_file_id text,source_link_index integer,display_name text,class_code text,
        student_name text,teacher_names text[] DEFAULT '{}',classroom_url text,file_url text,
        source_status text,source_created_at timestamptz,source_updated_at timestamptz,
        metadata jsonb DEFAULT '{}',dispatch_status text,next_dispatch_at timestamptz,
        updated_at timestamptz DEFAULT now(),
        UNIQUE(source_app_id,source_table_id,source_record_id,homework_file_id,source_link_index));`);
    const client = { query: (...args) => db.query(...args), release() {} };
    const pool = { query: client.query, async connect() { return client; } };
    const operations = createWritingFlowOperations({ pool });
    const source = { courseId: 'course-fake', courseWorkId: 'assignment-fake',
      submissionId: 'submission-fake', documentId: 'doc-fake', linkIndex: 1,
      displayName: 'Writing homework giả', classCode: 'IC2200', sourceStatus: 'TURNED_IN',
      classroomUrl: 'https://classroom.google.com/c/fake',
      fileUrl: 'https://docs.google.com/document/d/doc-fake/edit',
      sourceUpdatedAt: '2026-09-20T00:00:00Z' };
    await operations.upsertClassroomSources({ sources: [source] });
    await db.exec(`UPDATE writing_flow.source_record SET dispatch_status='acknowledged',
      next_dispatch_at=NULL,metadata=metadata || '{"writingFilter":"checked","writingAnchorReview":true}'::jsonb;`);
    await operations.upsertClassroomSources({ sources: [source] });
    let row = (await db.query('SELECT * FROM writing_flow.source_record')).rows[0];
    assert.equal(row.dispatch_status, 'acknowledged');
    assert.equal(row.next_dispatch_at, null);
    assert.equal(row.metadata.writingFilter, 'checked');
    assert.equal(row.metadata.writingAnchorReview, true);
    await operations.upsertClassroomSources({ sources: [{ ...source,
      sourceUpdatedAt: '2026-09-21T00:00:00Z' }] });
    row = (await db.query('SELECT * FROM writing_flow.source_record')).rows[0];
    assert.equal(row.dispatch_status, 'pending');
    assert.ok(row.next_dispatch_at);
    assert.equal(row.metadata.writingFilter, undefined);
  } finally {
    await db.close();
  }
});
