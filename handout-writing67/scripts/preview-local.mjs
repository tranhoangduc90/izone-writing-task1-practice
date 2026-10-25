import {createServer,request as httpRequest} from 'node:http';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,extname,sep} from 'node:path';
import {randomBytes} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createStore} from '../src/store.mjs';
import {createService} from '../src/service.mjs';
import {createTeacher} from '../src/teacher.mjs';
import {createApi} from '../src/http.mjs';
import {promptRenderer} from '../src/prompt.mjs';
import {gatewayAdapter,createProcessor} from '../src/processor.mjs';

// Chỉ loopback, roster giả và database riêng. Không đánh thức n8n hoặc ghi kho production.
const root=resolve(process.env.HANDOUT67_PREVIEW_DATA||''),pages=resolve(process.env.HANDOUT67_PREVIEW_PAGES||''),port=Number(process.env.HANDOUT67_PREVIEW_PORT||3211);
if(!process.env.HANDOUT67_PREVIEW_DATA||!process.env.HANDOUT67_PREVIEW_PAGES||port!==3211)throw new Error('PREVIEW_CONFIG_REQUIRED');
await mkdir(root,{recursive:true});
const runtime=JSON.parse(await readFile(resolve(root,'runtime.private.json'),'utf8'));
if(!runtime.gateway?.url||!runtime.gateway?.token)throw new Error('PREVIEW_GATEWAY_REQUIRED');
let secrets;try{secrets=JSON.parse(await readFile(resolve(root,'preview-secrets.private.json'),'utf8'));}catch{secrets={student:randomBytes(32).toString('hex'),teacher:randomBytes(32).toString('hex'),internal:randomBytes(32).toString('hex')};await writeFile(resolve(root,'preview-secrets.private.json'),JSON.stringify(secrets));}
const db=new PGlite(resolve(root,'preview-database'));
const schema=await db.query("SELECT schema_name FROM information_schema.schemata WHERE schema_name='handout67'");
if(!schema.rows.length)for(const file of ['001-initial.sql','002-activity-log.sql'])await db.exec(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
const render=await promptRenderer(resolve(root,'registry.preview.private.json'));
const students=[{studentRef:'preview-new',displayName:'Học viên mẫu · Tự làm thử'},{studentRef:'preview-complete',displayName:'Học viên mẫu · Bài minh họa hai thân bài'},{studentRef:'preview-qa',displayName:'Học viên mẫu · Kiểm chức năng'}];
const roster=async()=>[{classRef:'DEMO-L11',className:'Lesson 11 · Lớp xem thử',students},{classRef:'IC2304',className:'Mẫu hồi quy Lesson 5/7/9 · dữ liệu giả',students}];
const store=createStore(db),service=createService({store,roster,secret:secrets.student,renderJob:render,lessons:render.lessons,retryDelays:[0,5000,15000]});
const actor={email:'preview@izone.test',displayName:'Giảng viên bản xem thử',classes:['DEMO-L11','IC2304']};
const realTeacher=createTeacher({db,store,roster,secret:secrets.teacher,lessons:render.lessons,registry:()=>({clientId:'',teachers:[]}),verifyGoogleToken:async()=>{throw new Error('PREVIEW_ONLY');}});
// GV mẫu chỉ cho server loopback này. Bộ xác thực runtime/SSO phát hành giữ nguyên.
const teacher={...realTeacher,authorize:()=>actor};
const callAI=gatewayAdapter({gatewayUrl:runtime.gateway.url,gatewayToken:runtime.gateway.token});
const processor=createProcessor({service,callAI,onError:code=>console.error('PREVIEW_AI',code)});
const origin='http://127.0.0.1:'+port;
const api=createApi({service,teacher,processor,origins:[origin],internalSecret:secrets.internal});
await new Promise(r=>api.listen(0,'127.0.0.1',r));
const types={'.html':'text/html','.js':'text/javascript','.mjs':'text/javascript','.css':'text/css','.woff2':'font/woff2','.woff':'font/woff','.svg':'image/svg+xml','.png':'image/png'};
const server=createServer(async(req,res)=>{
 try{
  if(req.headers.host!=='127.0.0.1:'+port){res.writeHead(403);res.end();return;}
  const url=new URL(req.url,origin);
  if(url.pathname.startsWith('/api/handout67/v1/')){
   if(url.pathname.includes('/internal/')){res.writeHead(403);res.end();return;}
   const proxy=httpRequest({hostname:'127.0.0.1',port:api.address().port,path:req.url,method:req.method,headers:req.headers},reply=>{res.writeHead(reply.statusCode,reply.headers);reply.pipe(res);});proxy.on('error',()=>{res.writeHead(502);res.end();});req.pipe(proxy);return;
  }
  if(!['/writing-handouts/','/speaking-homework/fonts/','/shared/'].some(p=>url.pathname.startsWith(p))||decodeURIComponent(url.pathname).split('/').some(part=>part.startsWith('.'))){res.writeHead(404);res.end();return;}
  let file=resolve(pages,'.'+decodeURIComponent(url.pathname));if(!file.startsWith(pages+sep)){res.writeHead(403);res.end();return;}
  if((await stat(file)).isDirectory())file=resolve(file,'index.html');
  res.setHeader('Content-Type',(types[extname(file)]||'application/octet-stream')+'; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(await readFile(file));
 }catch{res.writeHead(404);res.end('Không tìm thấy trang xem thử.');}
});
await new Promise(r=>server.listen(port,'127.0.0.1',r));
let active=0,claiming=false;
setInterval(async()=>{if(claiming||active>=2)return;claiming=true;try{while(active<2){const [job]=await service.claim();if(!job)break;active++;void processor.process(job).catch(e=>console.error('PREVIEW_JOB_ERROR',e.code||e.message)).finally(()=>active--);}}finally{claiming=false;}},500).unref();
console.log('PREVIEW_READY '+origin+'/writing-handouts/lesson11/');
async function close(){server.close();api.close();processor.close();await db.close();process.exit();}
process.on('SIGINT',close);process.on('SIGTERM',close);
