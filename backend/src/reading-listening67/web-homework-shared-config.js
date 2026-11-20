import {readFile} from 'node:fs/promises';
import {isAbsolute} from 'node:path';
import pg from 'pg';
import {createGoogleDocsAccount,createGoogleDocsTokenProvider} from '../google-docs-write/google.js';
import {createDocsDocumentLock} from '../google-docs-write/lock.js';

export async function loadHomeworkSharedDocs(configFile,db){
 if(!configFile)return null;
 const config=JSON.parse(await readFile(configFile,'utf8'));
 const {all=false,classIds=[],primaryCredentialsFile,fallbackCredentialsFile,lockDatabaseFile}=config;
 if(typeof all!=='boolean'||!Array.isArray(classIds)||(!all&&!classIds.length)||
  !classIds.every(id=>typeof id==='string'&&/^[1-9][0-9]{0,17}$/.test(id))||
  ![primaryCredentialsFile,fallbackCredentialsFile,lockDatabaseFile].every(p=>typeof p==='string'&&isAbsolute(p))){
  throw Error('HOMEWORK_SHARED_DOCS_CONFIG_INVALID');
 }
 await db.query('SELECT shared_docs_attempt FROM reading_listening67.web_homework_job LIMIT 0');
 const pairs=await Promise.all(Object.entries({primary:primaryCredentialsFile,fallback:fallbackCredentialsFile}).map(async([role,path])=>{
  const credentials=JSON.parse(await readFile(path,'utf8'));
  return [role,createGoogleDocsAccount({role,getToken:createGoogleDocsTokenProvider({credentials})})];
 }));
 const pool=new pg.Pool({connectionString:(await readFile(lockDatabaseFile,'utf8')).trim(),
  max:2,connectionTimeoutMillis:4000,application_name:'homework_shared_docs_lock'});
 pool.on('error',()=>console.error(JSON.stringify({event:'homework_shared_docs_lock_connection_lost'})));
 const authorized=new Set(classIds);
 return {accounts:Object.fromEntries(pairs),withDocumentLock:createDocsDocumentLock(pool),
  applies:courseId=>all||authorized.has(courseId),close:()=>pool.end(),
  log:event=>console.log(JSON.stringify({event:'homework_shared_docs',...event}))};
}
