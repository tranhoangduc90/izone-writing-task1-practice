import fs from 'node:fs/promises';
import {Pool} from 'pg';
import {sha} from '../src/grading.mjs';
const url=new URL(process.env.TASK1_OWNER_DATABASE_URL||'');
if(!/^\/sw_task1(?:_test)?$/.test(url.pathname)||url.username!=='task1_owner')throw Error('TASK1_OWNER_DATABASE_REQUIRED');
const original=await fs.readFile(process.env.TASK1_HISTORY_FILE,'utf8'),snapshot=JSON.parse(original),digest=sha(original);
if(snapshot.tables.activity.length!==6||!snapshot.capturedAt.endsWith('Z'))throw Error('HISTORY_SNAPSHOT_INVALID');
const pool=new Pool({connectionString:url.href,max:1});
try{
 const old=await pool.query('SELECT sha256 FROM task1_private.history_snapshot WHERE id=1');
 if(old.rowCount&&old.rows[0].sha256!==digest)throw Error('HISTORY_SNAPSHOT_ALREADY_SET');
 await pool.query('INSERT INTO task1_private.history_snapshot(id,captured_at,sha256,original_text) VALUES(1,$1,$2,$3) ON CONFLICT DO NOTHING',[snapshot.capturedAt,digest,original]);
 console.log(JSON.stringify({outcome:'success',sha256:digest,counts:Object.fromEntries(Object.entries(snapshot.tables).map(([k,v])=>[k,v.length]))}));
}finally{await pool.end();}
