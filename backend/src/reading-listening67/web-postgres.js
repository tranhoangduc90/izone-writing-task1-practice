// Bộ nối PostgreSQL chuẩn: chỉ transaction trong DB riêng, không chạy migration.
// PGlite vẫn dùng ở local; cùng hợp đồng query/transaction cho kho web hiện có.
import pg from 'pg';
export function createReading67Postgres({connectionString,max=4}){
 const pool=new pg.Pool({connectionString,max,connectionTimeoutMillis:5000,statement_timeout:5000});
 return {
  query:(sql,values)=>pool.query(sql,values),
  async transaction(fn){const client=await pool.connect();try{await client.query('BEGIN');const result=await fn({query:(sql,values)=>client.query(sql,values)});await client.query('COMMIT');return result;}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}},
  close:()=>pool.end()
 };
}
