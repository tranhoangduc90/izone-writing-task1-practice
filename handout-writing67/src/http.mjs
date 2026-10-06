import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { PRODUCT, fail } from './service.mjs';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const prefix='/api/handout67/v1';
const equal=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function jsonBody(req,maxBytes=32768) {
  let length=0;const chunks=[];
  for await(const chunk of req) {length+=chunk.length;if(length>maxBytes)fail('BODY_TOO_LARGE',413);chunks.push(chunk);}
  try {return JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {fail('JSON_INVALID');}
}

// Nhận HTTP, kiểm origin/token và dữ liệu trước khi gọi nghiệp vụ; chỉ trả mã lỗi an toàn.
// ACK Check sau transaction. Không in bài, credential hoặc token khi SQL/AI lỗi.
export function createApi({service,teacher=null,processor=null,origins,internalSecret}) {
  const limits=new Map();
  const server=createServer(async(req,res)=>{
    res.setHeader('Content-Type','application/json; charset=utf-8');
    res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
    try {
      const origin=req.headers.origin;
      const requestUrl=new URL(req.url,'http://localhost');
      const teacherPath=requestUrl.pathname.startsWith(prefix+'/teacher/');
      if(origin && !origins.includes(origin))fail('ORIGIN_NOT_ALLOWED',403);
      if(origin){res.setHeader('Access-Control-Allow-Origin',origin);res.setHeader('Vary','Origin');if(teacherPath)res.setHeader('Access-Control-Allow-Credentials','true');}
      if(req.method==='OPTIONS') {res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,DELETE,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization,X-Handout67-CSRF');res.writeHead(204);res.end();return;}
      const path=requestUrl.pathname;
      const internal=path.startsWith(prefix+'/internal/');
      if(internal && !equal(req.headers.authorization,`Bearer ${internalSecret}`))fail('INTERNAL_UNAUTHORIZED',401);
      if(!internal && path!==prefix+'/health'){
        const now=Date.now();
        let key='bootstrap:'+req.socket.remoteAddress;
        const sessionPath=path.match(/^\/api\/handout67\/v1\/sessions\/([^/]+)(?:\/|$)/);
        if(sessionPath && uuid.test(sessionPath[1])) {
          service.authorizeSession(sessionPath[1],req.headers.authorization?.replace(/^Bearer /,''));
          key='session:'+sessionPath[1];
        }
        for(const [k,v] of limits)if(v.until<=now)limits.delete(k);
        if(limits.size>=10000&&!limits.has(key))fail('RATE_LIMITED',429);
        const bucket=limits.get(key)||{until:now+60000,count:0};bucket.count++;limits.set(key,bucket);
        if(bucket.count>120){res.setHeader('Retry-After','60');fail('RATE_LIMITED',429);}
      }
      let value,status=200;
      if(teacherPath){
        if(!teacher)fail('NOT_FOUND',404);
        const cookieName='izone_handout67_teacher';
        const cookie=value=>`${cookieName}=${value}; Path=${prefix}/teacher; HttpOnly; Secure; SameSite=None; Partitioned; Max-Age=${value?43200:0}`;
        const csrf=()=>{if(!origin||!origins.includes(origin)||req.headers['x-handout67-csrf']!=='1')fail('CSRF_REJECTED',403);};
        const raw=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith(cookieName+'='))?.slice(cookieName.length+1);
        if(path===prefix+'/teacher/config'&&req.method==='GET')value={clientId:teacher.clientId()};
        else if(path===prefix+'/teacher/session'&&req.method==='POST'){
          csrf();const login=await teacher.login((await jsonBody(req)).credential);
          res.setHeader('Set-Cookie',cookie(login.token));value={reviewer:login.reviewer};
        }else if(path===prefix+'/teacher/session'&&req.method==='DELETE'){
          csrf();res.setHeader('Set-Cookie',cookie(''));value={loggedOut:true};
        }else{
          const actor=teacher.authorize(raw);
          if(path===prefix+'/teacher/session'&&req.method==='GET')value={reviewer:teacher.actor(actor)};
          else if(path===prefix+'/teacher/classes'&&req.method==='GET')value={classes:await teacher.classes(actor)};
          else if(path===prefix+'/teacher/students'&&req.method==='GET')value=await teacher.summary(actor,requestUrl.searchParams.get('class'));
          else{
            const match=path.match(/^\/api\/handout67\/v1\/teacher\/sessions\/([^/]+)(\/(?:comments|activity))?$/);
            if(!match||!uuid.test(match[1]))fail('NOT_FOUND',404);
            if(req.method==='GET'&&!match[2])value={session:await teacher.detail(actor,match[1])};
            else if(req.method==='GET'&&match[2]==='/activity')value=await teacher.activity(actor,match[1],{limit:Number(requestUrl.searchParams.get('limit')||100),before:requestUrl.searchParams.get('before'),jobRef:requestUrl.searchParams.get('job')});
            else if(req.method==='POST'&&match[2]==='/comments'){csrf();value={session:await teacher.comment(actor,match[1],await jsonBody(req))};}
            else fail('NOT_FOUND',404);
          }
        }
      }else if(path===prefix+'/health'&&req.method==='GET')value={productId:PRODUCT,version:'0.1.0',status:'alive'};
      else if(path===prefix+'/roster'&&req.method==='GET')value={classes:await service.roster()};
      else if(path===prefix+'/sessions'&&req.method==='POST'){value=await service.open(await jsonBody(req));status=201;}
      else if(path===prefix+'/internal/jobs/claim'&&req.method==='POST'){await jsonBody(req);value={jobs:await service.claim()};}
      else if(internal){
        const match=path.match(/^\/api\/handout67\/v1\/internal\/jobs\/([^/]+)(\/(?:complete|response|process))?$/);
        if(!match || !uuid.test(match[1]))fail('NOT_FOUND',404);
        if(req.method==='GET'&&!match[2])value=await service.job(match[1]);
        else if(req.method==='POST'&&match[2]){
          const body=await jsonBody(req,match[2]==='/response'?524288:32768);
          if(body.jobRef!==match[1])fail('CALLBACK_IDENTITY_MISMATCH',409);
          if(match[2]==='/process'){if(!processor)fail('NOT_FOUND',404);value=await processor.process(body);}
          else value=await (match[2]==='/response'?service.receive(body):service.complete(body));
        }
        else fail('NOT_FOUND',404);
      } else {
        const match=path.match(/^\/api\/handout67\/v1\/sessions\/([^/]+)(?:\/(responses|checks|idea2|vocabulary\/[12]\/retry))?$/);
        if(!match||!uuid.test(match[1]))fail('NOT_FOUND',404);
        const ref=match[1],token=req.headers.authorization?.replace(/^Bearer /,'');
        if(req.method==='GET'&&!match[2])value={session:await service.read(ref,token)};
        else if(req.method==='PUT'&&match[2]==='responses')value={session:await service.save(ref,token,await jsonBody(req))};
        else if(req.method==='POST'&&match[2]==='checks'){value=await service.check(ref,token,await jsonBody(req));status=202;}
        else if(req.method==='POST'&&match[2]==='idea2'){await jsonBody(req);value={session:await service.openIdea2(ref,token)};}
        else if(req.method==='POST'&&match[2]?.startsWith('vocabulary/')){await jsonBody(req);value={session:await service.retryVocabulary(ref,token,Number(match[2].split('/')[1]))};}
        else fail('NOT_FOUND',404);
      }
      res.writeHead(status);res.end(JSON.stringify({ok:true,...value}));
    } catch(error) {
      const status=Number.isInteger(error.status)?error.status:500;
      if(!res.headersSent){res.writeHead(status);res.end(JSON.stringify({ok:false,error:status===500?'TECHNICAL_FAILURE':error.message}));}
      else res.end();
    }
  });
  server.requestTimeout=10000;server.headersTimeout=10000;server.keepAliveTimeout=5000;
  return server;
}
