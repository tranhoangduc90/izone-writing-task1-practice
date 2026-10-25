import fs from 'node:fs/promises';
import {Pool} from 'pg';
import {sha} from '../src/grading.mjs';
const url=new URL(process.env.TASK1_OWNER_DATABASE_URL||'');
if(!/^\/sw_task1(?:_test)?$/.test(url.pathname)||url.username!=='task1_owner')throw Error('TASK1_OWNER_DATABASE_REQUIRED');
const pool=new Pool({connectionString:url.href,max:1});
try{
 const password=(await fs.readFile(process.env.TASK1_API_PASSWORD_FILE,'utf8')).trim();if(password.length<32)throw Error('TASK1_API_PASSWORD_REQUIRED');
 const role=await pool.query("SELECT 1 FROM pg_roles WHERE rolname='task1_api'");
 if(!role.rowCount){const sql=await pool.query("SELECT format('CREATE ROLE task1_api LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD %L',$1::text) statement",[password]);await pool.query(sql.rows[0].statement);}
 await pool.query('REVOKE CONNECT ON DATABASE postgres,template1 FROM PUBLIC');
 await pool.query('CREATE TABLE IF NOT EXISTS public.task1_schema_migration(name text PRIMARY KEY,sha256 text NOT NULL)');
 for(const name of ['001-initial.sql','002-runtime-grants.sql','003-preview-history.sql']){
  const sql=(await fs.readFile(new URL('../db/'+name,import.meta.url),'utf8')).replaceAll('\r\n','\n'),digest=sha(sql);
  const prior=await pool.query('SELECT sha256 FROM public.task1_schema_migration WHERE name=$1',[name]);
  if(prior.rowCount){if(prior.rows[0].sha256!==digest)throw Error('MIGRATION_HASH_CHANGED');continue;}
  await pool.query('BEGIN');try{await pool.query(sql.replace(/^BEGIN;\s*$/gm,'').replace(/^COMMIT;\s*$/gm,'').replaceAll('ON DATABASE sw_task1 ',`ON DATABASE ${url.pathname.slice(1)} `));await pool.query('INSERT INTO public.task1_schema_migration VALUES($1,$2)',[name,digest]);await pool.query('COMMIT');}catch(e){await pool.query('ROLLBACK');throw e;}
 }
 console.log(JSON.stringify({outcome:'success',productId:'sw-task1',migrations:3}));
}finally{await pool.end();}
