// Cầu nối phiên riêng biệt: cấu hình allowlist nguồn, chỉ nhận cookie từ origin đã duyệt.
import fs from 'node:fs/promises';
import {createTeacherSsoApp} from '../src/teacher-sso/http-app.js';
import pg from 'pg';
import {OAuth2Client} from 'google-auth-library';
import {createRemoteNative} from '../src/teacher-sso/remote-session.js';
import {createNativeSession} from '../src/teacher-sso/native-session.js';
import {createSharedTeacherSession} from '../src/teacher-sso/service.js';
const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
if(config.port!==8962||!config.sources||!config.origins?.length)throw Error('SSO_CONFIG_INVALID');
const pools=[],sources={};
for(const [id,source] of Object.entries(config.sources)){
 if(source.kind==='identity'){
  sources[id]={...source,native:source.legacyUrl?createRemoteNative({url:source.legacyUrl,cookieName:source.cookieName,bootstrapKey:(await fs.readFile(source.consumerKeyFile,'utf8')).trim()}):null};continue;
 }
 const pool=new pg.Pool({connectionString:source.connectionString,max:2,connectionTimeoutMillis:3000,statement_timeout:4000});pools.push(pool);
 const role=(await pool.query('SELECT current_user AS name,rolsuper,rolcreatedb,rolcreaterole FROM pg_roles WHERE rolname=current_user')).rows[0];
 if(role.name!=='izone_teacher_sso'||role.rolsuper||role.rolcreatedb||role.rolcreaterole)throw Error('SSO_ROLE_INVALID');
 sources[id]={...source,native:createNativeSession({pool,kind:source.kind,schema:source.schema})};
}
const service=createSharedTeacherSession({file:config.store,key:Buffer.from((await fs.readFile(config.keyFile,'utf8')).trim(),'hex'),sources});
const consumerKeys=new Map();
for(const [id,source] of Object.entries(config.sources))if(source.consumerKeyFile)consumerKeys.set(id,(await fs.readFile(source.consumerKeyFile,'utf8')).trim());
const oauth=new OAuth2Client();oauth.transporter.defaults={...oauth.transporter.defaults,timeout:5000};
const app=createTeacherSsoApp({config,sources,service,consumerKeys,verifyGoogleToken:async(credential,audience)=>(await oauth.verifyIdToken({idToken:credential,audience})).getPayload()});
const server=app.listen(config.port,'0.0.0.0');
async function close(){server.close();service.close();await Promise.all(pools.map(p=>p.end()));process.exit(0);}
process.on('SIGTERM',close);process.on('SIGINT',close);
