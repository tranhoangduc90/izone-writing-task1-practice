import pg from 'pg';
import { createWake } from './wake.mjs';
import { promptRenderer } from './prompt.mjs';
import { config,rosterAdapter } from './config.mjs';
import { createStore,postgresAdapter } from './store.mjs';
import { createService } from './service.mjs';
import { createApi } from './http.mjs';

// Chỉ mở tiến trình Handout 67. Không import app/server/notifier Writing hoặc biến env chung.
const settings=config();
const pool=new pg.Pool({connectionString:settings.databaseUrl,max:5,connectionTimeoutMillis:5000,statement_timeout:10000,idleTimeoutMillis:30000});
const target=await pool.query('SELECT current_database() AS db, current_user AS role');
if(target.rows[0].db!=='handout_writing67'||target.rows[0].role!=='handout67_runtime')throw new Error('Database thực tế sai đích.');
await pool.query('SELECT ref FROM handout67.session LIMIT 1');
const service=createService({store:createStore(postgresAdapter(pool)),roster:rosterAdapter(settings),secret:settings.secret,renderJob:await promptRenderer(settings.promptFile)});
const wake=createWake({url:settings.wakeUrl,secret:settings.wakeSecret,hasWork:async()=>{const result=await pool.query("SELECT EXISTS (SELECT 1 FROM handout67.session s, jsonb_array_elements(s.payload->'jobs') j WHERE j->>'status'='queued' OR (j->>'status'='leased' AND (j->>'leaseUntil')::bigint <= $1)) AS pending",[Date.now()]);return result.rows[0].pending;},onError:()=>console.error('Handout Writing 67: chưa đánh thức được đường chấm; job vẫn được giữ.')});
const server=createApi({service,...settings});
void wake.tick();
server.listen(settings.port,'0.0.0.0',()=>console.log('Handout Writing 67 đã sẵn sàng nhận HTTP.'));
let closing=false;
async function stop(){if(closing)return;closing=true;wake.close();server.close(async()=>{await pool.end();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
