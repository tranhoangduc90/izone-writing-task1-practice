// Bộ nối PostgreSQL chuẩn: chỉ transaction trong DB riêng, không chạy migration.
// PGlite vẫn dùng ở local; cùng hợp đồng query/transaction cho kho web hiện có.
import pg from 'pg';
import {createWebWorkCoordinator} from './web-work-coordinator.js';
export function createReading67Postgres({connectionString,max=4,workCoordinatorEnabled=false}){
 const pool=new pg.Pool({connectionString,max,connectionTimeoutMillis:5000,statement_timeout:5000});
 const db={
  query:(sql,values)=>pool.query(sql,values),
  async transaction(fn){const client=await pool.connect(),callbacks=[];let result;try{await client.query('BEGIN');result=await fn({query:(sql,values)=>client.query(sql,values),afterCommit:callback=>callbacks.push(callback)});await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}for(const callback of callbacks){try{callback();}catch{/* A wake-up cannot invalidate a committed save. */}}return result;},
  async close(){await db.workCoordinator?.close();await pool.end();}
 };
 if(workCoordinatorEnabled)db.workCoordinator=createWebWorkCoordinator({db});
 return db;
}
