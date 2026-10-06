import pg from 'pg';
import { readFile } from 'node:fs/promises';

// Admin được duyệt cấp database/role riêng trước; lệnh chỉ tạo schema/bảng handout.
// Không chạy migration tự động lúc server start; sai tên database thì dừng trước ghi.
const url=new URL(process.env.HANDOUT67_MIGRATION_URL||'');
if(decodeURIComponent(url.pathname)!=='/handout_writing67')throw new Error('Migration chỉ được chạy trong handout_writing67.');
const pool=new pg.Pool({connectionString:url.href,max:1});
try {
  const row=await pool.query('SELECT current_database() AS db');
  if(row.rows[0].db!=='handout_writing67')throw new Error('Sai database thực tế.');
  await pool.query('BEGIN');
  try{
    for(const name of ['001-initial.sql','002-activity-log.sql'])await pool.query(await readFile(new URL('../db/'+name,import.meta.url),'utf8'));
    await pool.query('COMMIT');
  }catch(error){await pool.query('ROLLBACK');throw error;}
  console.log('Đã tạo bảng bài làm/nhật ký handout67; cần readback quyền runtime và hàm dọn hạn theo runbook.');
} finally {await pool.end();}
