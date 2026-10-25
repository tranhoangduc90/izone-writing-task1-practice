import fs from 'node:fs/promises';
import path from 'node:path';
import {sha} from '../src/grading.mjs';
export async function loadPrompts(pool,directory){
 const pack=JSON.parse(await fs.readFile(path.join(directory,'prompt-package.json'),'utf8'));
 if(!/^2026-10-25\.socratic-v2\.\d+$/.test(pack.version)||pack.prompts.length!==18)throw Error('PROMPT_PACKAGE_INVALID');
 const rows=[],keys=new Set();
 for(const p of pack.prompts){
  const key=[p.slug,p.section,p.version].join('/');if(keys.has(key)||p.version!==pack.version)throw Error('DUPLICATE_PROMPT');keys.add(key);
  const name=p.path.split(/[\\/]/).at(-1);if(!/^[a-z0-9.-]+\.md$/.test(name)||!['overview','outline','draft'].includes(p.section))throw Error('PROMPT_PATH_INVALID');
  const text=await fs.readFile(path.join(directory,'prompts',name),'utf8');if(sha(text)!==p.sha256||text.includes('{{TASK_REFERENCE}}'))throw Error('PROMPT_HASH_MISMATCH');
  rows.push([p.slug,p.section,p.version,text,p.sha256]);
 }
 const client=await pool.connect();try{
  await client.query('BEGIN');
  for(const row of rows){
   const existing=await client.query('SELECT sha256 FROM task1_private.prompt WHERE slug=$1 AND section=$2 AND version=$3',row.slice(0,3));
   if(existing.rowCount&&existing.rows[0].sha256!==row[4])throw Error('IMMUTABLE_PROMPT_VERSION');
   await client.query('INSERT INTO task1_private.prompt VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',row);
  }
  await client.query('COMMIT');return {version:pack.version,prompts:rows.length};
 }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
