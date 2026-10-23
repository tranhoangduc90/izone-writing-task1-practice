/**
 * Mở máy chủ thử cục bộ: PostgreSQL nhúng lưu bền, bộ chấm/prompt live đã ghim.
 * Nhận đường nguồn riêng tư qua config file; fixture A/B chỉ ở localhost.
 * Không mở runtime Writing, không chạy migration VPS, không gọi Docs/Classroom.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes,createHmac,timingSafeEqual} from 'node:crypto';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {loadReading67WebGrader,READING67_WEB_CODE} from '../src/reading-listening67/web-grader.js';
import {createReading67WebStore,createReading67WebWorker} from '../src/reading-listening67/web-store.js';
import {createReading67WebRouter} from '../src/reading-listening67/web-routes.js';

const config=JSON.parse(await fs.readFile(process.argv[2],'utf8'));
if(config.mode!=='local_test'||!path.isAbsolute(config.dataDir))throw Error('LOCAL_TEST_CONFIG_REQUIRED');
const port=config.port||8948;
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('TEST_PORT_INVALID');
await fs.mkdir(config.dataDir,{recursive:true});
const secretFile=path.join(config.dataDir,'session-key.private');
let secret;try{secret=await fs.readFile(secretFile);}catch(error){if(error.code!=='ENOENT')throw error;secret=randomBytes(32);await fs.writeFile(secretFile,secret,{flag:'wx'});}
const content=JSON.parse(await fs.readFile(config.contentPath,'utf8'));
if(content.code!==READING67_WEB_CODE)throw Error('CONTENT_CODE_MISMATCH');
const grader=await loadReading67WebGrader({snapshotPath:config.graderPath,expectedSha256:config.graderSha256});
const db=new PGlite(path.join(config.dataDir,'postgres'));
await db.exec(await fs.readFile(new URL('../../docs/migrations/2026-10-22-reading67-web.sql',import.meta.url),'utf8'));
const store=createReading67WebStore({db,grader});await store.recoverExpired();
const worker=createReading67WebWorker({store,grader,onError:error=>console.error(JSON.stringify({event:'grading_error',code:error.code||'GRADING_VALIDATION_FAILED'}))});
const people={A:{ownerId:'11111111-1111-4111-8111-111111111111',courseId:'reading67-web-preview',name:'Học viên thử A',className:'Lớp thử Reading 67'},B:{ownerId:'22222222-2222-4222-8222-222222222222',courseId:'reading67-web-preview',name:'Học viên thử B',className:'Lớp thử Reading 67'}};
const signature=value=>createHmac('sha256',secret).update(value).digest('base64url');
function authenticate(q){
  const cookie=String(q.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith('reading67_stage2='))?.slice('reading67_stage2='.length);
  if(!cookie)return null;
  const [value,mac]=cookie.split('.');const expected=signature(value||'');
  if(!mac||mac.length!==expected.length||!timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))return null;
  try{const data=JSON.parse(Buffer.from(value,'base64url').toString('utf8'));if(data.expires<Date.now()||!people[data.person])return null;return people[data.person];}catch{return null;}
}
const app=express();app.disable('x-powered-by');
app.use((q,r,next)=>{r.set('Cache-Control','no-store');r.set('X-Content-Type-Options','nosniff');if(q.headers.origin&&q.headers.origin!==`http://127.0.0.1:${port}`&&q.headers.origin!==`http://localhost:${port}`)return r.status(403).json({ok:false,error:'ORIGIN_NOT_ALLOWED'});next();});
app.post('/_preview/session',express.json({limit:'1kb'}),(q,r)=>{
  if(!people[q.body?.person]||Object.keys(q.body).length!==1)return r.status(400).json({ok:false,error:'PREVIEW_PERSON_INVALID'});
  const value=Buffer.from(JSON.stringify({person:q.body.person,expires:Date.now()+86400000})).toString('base64url');
  r.cookie('reading67_stage2',value+'.'+signature(value),{httpOnly:true,sameSite:'strict',maxAge:86400000,path:'/'});r.json({ok:true,identity:people[q.body.person],fixtureIdentity:true});
});
app.use('/api/reading-skills67',createReading67WebRouter({store,content,grader,authenticate}));
const pages=path.resolve(config.pagesPath);
app.get('/health',async(_q,r)=>{try{await db.query('SELECT 1');r.json({ok:true,mode:'local_test_real_grading',database:'PostgreSQL/PGlite',graderHash:grader.pins.sha256});}catch{r.status(503).json({ok:false});}});
app.get('/reading-skills67/',(_q,r)=>r.sendFile(path.join(pages,'reading-skills67/index.html')));
app.use('/reading-skills67',express.static(path.join(pages,'reading-skills67'),{dotfiles:'deny',index:false}));
for(const file of ['styles.css','annotations.js','explanation-dialog.css','term-style/computer-based.css'])app.get('/reading-practice/'+file,(_q,r)=>r.sendFile(path.join(pages,'reading-practice',file)));
app.use('/reading-practice/fonts',express.static(path.join(pages,'reading-practice/fonts'),{dotfiles:'deny',index:false}));
app.get('/favicon.ico',(_q,r)=>r.status(204).end());
app.get('/',(_q,r)=>r.redirect('/reading-skills67/?server=1'));
app.use((_q,r)=>r.status(404).json({ok:false,error:'NOT_FOUND'}));
const server=app.listen(port,'127.0.0.1',()=>{worker.start();console.log(JSON.stringify({outcome:'ready',url:`http://127.0.0.1:${port}/reading-skills67/?server=1`,graderHash:grader.pins.sha256,database:'persistent_local_postgresql',identity:'fixture_A_B',productionChanged:false}));});
server.requestTimeout=30000;server.headersTimeout=31000;
async function close(){server.close();await worker.close();await db.close();process.exit(0);}
process.on('SIGINT',close);process.on('SIGTERM',close);
