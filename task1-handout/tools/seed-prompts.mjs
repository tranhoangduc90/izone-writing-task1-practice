import {Pool} from 'pg';
import {loadPrompts} from './load-prompts.mjs';
const url=new URL(process.env.TASK1_OWNER_DATABASE_URL||'');
if(!/^\/sw_task1(?:_test)?$/.test(url.pathname)||url.username!=='task1_owner')throw Error('TASK1_OWNER_DATABASE_REQUIRED');
const pool=new Pool({connectionString:url.href,max:1});
try{console.log(JSON.stringify({outcome:'success',...await loadPrompts(pool,process.env.TASK1_PROMPT_PACKAGE_DIR)}));}finally{await pool.end();}
