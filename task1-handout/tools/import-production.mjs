import fs from 'node:fs/promises';
import {Pool} from 'pg';
import {sha} from '../src/grading.mjs';
const url=new URL(process.env.TASK1_OWNER_DATABASE_URL||'');if(url.username!=='task1_owner'||url.pathname!=='/sw_task1')throw Error('TASK1_OWNER_REQUIRED');
const raw=await fs.readFile(process.env.TASK1_IMPORT_FILE,'utf8'),data=JSON.parse(raw),tables=['activity','activity_class_scope','activity_roster','activity_roster_override','activity_section_definition','provisional_student','activity_student_alias','provisional_student_audit','activity_session','session_section','draft_request','check_attempt','comment','admin_audit_event','teacher_comment_thread','teacher_comment_message','teacher_comment_status_event','grading_dispatch'];
if(Object.keys(data.tables).sort().join()!==tables.slice().sort().join()||data.tables.activity.length!==6||!/[Zz]|[+-]\d\d:\d\d$/.test(data.capturedAt))throw Error('COMPLETE_TASK1_SNAPSHOT_REQUIRED');
const pool=new Pool({connectionString:url.href,max:1}),client=await pool.connect();
try{
 await client.query('BEGIN');
 if((await client.query('SELECT phase FROM task1_private.cutover_state WHERE id=1 FOR UPDATE')).rows[0]?.phase!=='prepared')throw Error('LIVE_DATABASE_IMPORT_FORBIDDEN');
 await client.query('ALTER TABLE writing_practice.check_attempt DISABLE TRIGGER freeze_task1_context');
 for(const table of tables){
  const rows=data.tables[table];if(!rows.length)continue;
  const meta=(await client.query("SELECT column_name,is_generated FROM information_schema.columns WHERE table_schema='writing_practice' AND table_name=$1",[table])).rows;
  const writable=new Set(meta.filter(x=>x.is_generated==='NEVER').map(x=>x.column_name)),known=new Set(meta.map(x=>x.column_name));
  const columns=Object.keys(rows[0]).filter(k=>writable.has(k));
  for(const row of rows)for(const key of Object.keys(row))if(!known.has(key))throw Error('UNMAPPED_LEGACY_FIELD:'+table+'.'+key);
  const pk=(await client.query("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY array_position(i.indkey,a.attnum)",['writing_practice.'+table])).rows.map(x=>x.attname);
  const quote=x=>'"'+x.replaceAll('"','""')+'"',names=columns.map(quote).join(','),updates=columns.filter(x=>!pk.includes(x)).map(x=>quote(x)+'=EXCLUDED.'+quote(x)).join(',');
  await client.query(`INSERT INTO writing_practice.${table}(${names}) SELECT ${names} FROM json_populate_recordset(NULL::writing_practice.${table},$1::json) ON CONFLICT(${pk.map(quote).join(',')}) DO ${updates?'UPDATE SET '+updates:'NOTHING'}`,[JSON.stringify(rows)]);
 }
 await client.query('ALTER TABLE writing_practice.check_attempt ENABLE TRIGGER freeze_task1_context');
 await client.query("UPDATE writing_practice.activity SET prompt_version='2026-10-25.socratic-v2.5',prompt_registry_key='sw-task1-private',prompt_record_ref='socratic-v2' WHERE grading_pool='task1'");
 for(const table of tables){
  const seq=await client.query("SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=$1::regclass AND attname='id') THEN pg_get_serial_sequence($1::text,'id') END AS name",['writing_practice.'+table]);
  if(seq.rows[0]?.name)await client.query(`SELECT setval($1::regclass,coalesce((SELECT max(id) FROM writing_practice.${table}),1),EXISTS(SELECT 1 FROM writing_practice.${table}))`,[seq.rows[0].name]);
 }
 await client.query('INSERT INTO task1_private.migration_archive(sha256,original_text,captured_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[sha(raw),raw,data.capturedAt]);
 await client.query('COMMIT');console.log(JSON.stringify({outcome:'success',sha256:sha(raw),counts:Object.fromEntries(tables.map(t=>[t,data.tables[t].length]))}));
}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();await pool.end();}
