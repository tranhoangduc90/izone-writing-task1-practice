// HTTPS thử riêng: Google thật, phiên/SQL/quyền thật; lớp và bài mẫu lưu ở đích riêng.
// Chỉ cho đăng nhập/đăng xuất và đọc dashboard. Không có đường AI, nộp bài hoặc Portal.
import fs from 'node:fs';
import {createHmac} from 'node:crypto';
import express from 'express';
import pg from 'pg';
import {OAuth2Client} from 'google-auth-library';
import {createSharedTeacherSession} from './sso/service.js';
import {createNativeSession} from './sso/native-session.js';
import {createTeacherSsoApp} from './sso/http-app.js';
import {createSharedTeacherVerifier} from './sso/consumer.js';
import {createAuthService} from './mapping/auth.js';
import {createApi} from './handout/http.mjs';
import {createTeacher} from './handout/teacher.mjs';
import {createStore,postgresAdapter} from './handout/store.mjs';
import {createService as handoutService} from './handout/service.mjs';
import {LEGACY_LESSON5} from './handout/lessons.mjs';
import {SubstituteStore} from './substitute/store.mjs';
import {createService as substituteService} from './substitute/service.mjs';
import {createSharedTeacherHandler} from './substitute/teacher-shared-handler.mjs';
import {createHttpServer} from './substitute/http.mjs';
import {TESTS} from './substitute/contract.mjs';

const config=JSON.parse(fs.readFileSync('/run/preview/config.json','utf8'));
const prefix='/teacher-login-preview-api',origin='https://tranhoangduc90.github.io';
const oauth=new OAuth2Client();oauth.transporter.defaults={...oauth.transporter.defaults,timeout:5000};
const verifyGoogleToken=async(token,audience)=>(await oauth.verifyIdToken({idToken:token,audience})).getPayload();
const pools={},sources={handout67:{kind:'identity',googleClientId:config.handoutClientId},substitute:{kind:'identity',googleClientId:config.substituteClientId}};
for(const id of ['k56','k56demo']){
 const pool=pools[id]=new pg.Pool({connectionString:config.databases[id],max:2});
 sources[id]={kind:'reviewer',cookieName:'izone_preview_'+id,cookiePath:prefix+(id==='k56'?'/mapping-api-k56':'/mapping-api-demo'),native:createNativeSession({pool,kind:'reviewer',schema:'mapping'})};
}
const service=createSharedTeacherSession({file:'/data/sessions.sqlite',key:Buffer.from(config.key,'hex'),sources});
const consumerKeys=new Map(Object.entries(config.consumerKeys));
const broker=createTeacherSsoApp({config:{origins:[origin],revision:config.revision},sources,service,consumerKeys,verifyGoogleToken});
const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
const verify=id=>createSharedTeacherVerifier({url:'http://127.0.0.1:8966/internal/identity/'+id,key:config.consumerKeys[id]});
app.use((q,r,next)=>{
 r.set('Cache-Control','no-store');
 if(q.headers.origin===origin){r.set('Access-Control-Allow-Origin',origin);r.set('Access-Control-Allow-Credentials','true');r.set('Vary','Origin');}
 if(q.headers.origin&&q.headers.origin!==origin)return r.status(403).json({error:'ORIGIN_NOT_ALLOWED'});
 if(q.method==='OPTIONS'){r.set('Access-Control-Allow-Headers','Content-Type,X-Izone-Csrf,X-Handout67-CSRF');r.set('Access-Control-Allow-Methods','GET,POST,DELETE,OPTIONS');return r.sendStatus(204);}
 next();
});
// Chỉ health có metadata công khai; không trả cookie, email hoặc khóa.
app.get('/health',(_q,r)=>r.json({ok:true,revision:config.revision,isolated:true,products:Object.keys(sources)}));
// Giữ đường nội bộ đúng nguyên bản, không để mount cắt /internal.
app.post('/internal/identity/:product',(q,r,next)=>broker(q,r,next));
app.use('/teacher-session-api',broker);
for(const id of ['k56','k56demo']){
 const root=id==='k56'?'/mapping-api-k56':'/mapping-api-demo',pool=pools[id];
 const auth=createAuthService({config:{authMode:'google',googleClientId:config.k56ClientId,nodeEnv:'production',allowedOrigins:new Set([origin]),teacherSessionCookieName:sources[id].cookieName,teacherSessionCookiePath:sources[id].cookiePath},pool,verifyGoogleToken:token=>verifyGoogleToken(token,config.k56ClientId)});
 const router=express.Router();router.use(express.json({limit:'12kb'}));
 const csrf=(q,r,next)=>q.headers.origin===origin&&q.headers['x-izone-csrf']==='1'?next():r.status(403).json({error:'CSRF_REJECTED'});
 router.post('/api/auth/session',(q,r,next)=>q.headers.origin===origin?next():r.status(403).json({error:'ORIGIN_NOT_ALLOWED'}),auth.login);
 router.delete('/api/auth/session',csrf,auth.logout);
 router.post('/api/auth/session/shared-session',(q,r)=>broker.handle(Object.assign(q,{url:'/v1/source/'+id}),r));
 router.use('/api',auth.authenticate);
 router.get('/api/auth/session',(q,r)=>r.json({ok:true,reviewer:q.reviewer}));
 router.get('/api/term-tests/teacher/options',(q,r)=>r.json({ok:true,reviewer:q.reviewer,classes:[{id:'fixture-'+id,name:id==='k56'?'IC2264':'CODEXDEMO56'}],tests:[{slug:'term-test-1-k56',title:'Bài mẫu đăng nhập · không có bài thật',scoreMode:'raw',sectionTotals:{listening:40,reading:26},writingTasks:[2]}]}));
 router.get('/api/term-tests/teacher/results',(q,r)=>q.query.classId&&q.query.classId!=='fixture-'+id?r.status(403).json({error:'ACCESS_DENIED'}):r.json({ok:true,students:[]}));
 app.use(root,router);
}
// Handout: API và quyền giữ mã live đã ghim. SQL chỉ trỏ database thử.
const handoutDb=pools.handout=new pg.Pool({connectionString:config.databases.handout,max:2});
const store=createStore(postgresAdapter(handoutDb));
const roster=async()=>[{classRef:'IC2304',className:'Lớp thử SSO · IC2304 giả',students:[{studentRef:'preview-student-a',displayName:'Học viên mẫu A'},{studentRef:'preview-student-b',displayName:'Học viên mẫu B'}]},{classRef:'OTHER',className:'Lớp không có quyền',students:[]}];
const lesson={...LEGACY_LESSON5,classes:['IC2304']};
const handout=handoutService({store,roster,secret:config.handoutSecret,lessons:{lesson5:lesson}});
const teacher=createTeacher({db:handoutDb,store,roster,registry:()=>({clientId:config.handoutClientId,teachers:[{...config.teacher,classes:['IC2304'],role:'teacher'}]}),secret:config.handoutSecret,verifyGoogleToken,lessons:{lesson5:lesson}});
const handoutHttp=createApi({service:handout,teacher,origins:[origin],internalSecret:config.internalSecret,verifySharedTeacher:verify('handout67'),ssoBootstrapKey:config.consumerKeys.handout67});
await new Promise(resolve=>handoutHttp.listen(8967,'127.0.0.1',resolve));
// Không mở API ghi/chấm, kể cả khi biết đường nội bộ.
const proxy=(port)=>async(q,r)=>{
 const upstream=await fetch('http://127.0.0.1:'+port+q.originalUrl,{method:q.method,headers:q.headers,redirect:'manual',signal:AbortSignal.timeout(8000)});
 r.status(upstream.status);for(const [name,value] of upstream.headers)if(!['transfer-encoding','content-length','connection','set-cookie'].includes(name))r.set(name,value);
 for(const cookie of upstream.headers.getSetCookie())r.append('Set-Cookie',cookie.replaceAll('izone_handout67_teacher','izone_preview_handout').replace('Path=/api/','Path='+prefix+'/api/'));
 r.send(Buffer.from(await upstream.arrayBuffer()));
};
app.use('/api/handout67/v1',(q,r,next)=>{
 if(q.path==='/teacher/shared-session')return r.status(401).json({error:'SSO_LOGIN_REQUIRED'});
 if(q.method!=='GET'&&!(q.method==='DELETE'&&q.path==='/teacher/session'))return r.status(405).json({error:'PREVIEW_READ_ONLY'});
 // DELETE chỉ xóa cookie cũ ở API Handout; phiên chung được client thu hồi riêng.
 if(q.method==='DELETE')return r.json({ok:true,loggedOut:true});
 return proxy(8967)(q,r,next);
});
// Substitute: SQLite riêng và grant DEMO, không tạo attempt hoặc worker/outbox.
const subStore=new SubstituteStore({file:'/data/substitute.sqlite',encryptionKey:Buffer.from(config.substituteKey,'hex')});
subStore.replaceReviewerAccounts([{email:config.teacher.email,subject:config.teacher.subject,grants:Object.keys(TESTS).map(testSlug=>({testSlug,classCode:'DEMO'}))}]);
const keys=Object.fromEntries(Object.keys(TESTS).map(id=>[id,Object.fromEntries(['ingest','reader','grader','portal-plan','portal'].map(role=>[role,createHmac('sha256',config.internalSecret).update(id+':'+role).digest('base64url')]))]));
const createHandle=verifyTeacher=>substituteService({store:subStore,keys,allowedOrigin:origin,googleClientId:config.substituteClientId,verifyTeacher});
const subHandle=createSharedTeacherHandler({handle:createHandle(async()=>{throw Error('SSO_ONLY');}),createHandle,allowedOrigin:origin,verifyShared:verify('substitute')});
const subHttp=createHttpServer(subHandle);await new Promise(resolve=>subHttp.listen(8968,'127.0.0.1',resolve));
app.use('/substitute-teacher-api',(q,r)=>{
 if(q.method!=='GET')return r.status(405).json({error:'PREVIEW_READ_ONLY'});
 const original=q.originalUrl;q.originalUrl=q.url;const result=proxy(8968)(q,r);q.originalUrl=original;return result;
});
app.use((error,_q,r,_next)=>r.status(error.status||503).json({ok:false,error:error.code||'PREVIEW_UNAVAILABLE'}));
const server=app.listen(8966,'0.0.0.0');
console.log(JSON.stringify({ready:true,revision:config.revision,isolated:true}));
process.on('SIGTERM',()=>{server.close();handoutHttp.close();subHttp.close();service.close();subStore.close();Promise.all(Object.values(pools).map(p=>p.end())).then(()=>process.exit(0));});
