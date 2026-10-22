// Kiểm quyền qua HTTPS thật bằng phiên fixture do tiến trình thử cấp trực tiếp.
// Đây là kiểm quyền consumer, không thay bằng chứng xác minh chữ ký Google thật trên UI.
import fs from 'node:fs';
import pg from 'pg';
import assert from 'node:assert/strict';
import {createSharedTeacherSession} from './sso/service.js';
import {createNativeSession} from './sso/native-session.js';
const config=JSON.parse(fs.readFileSync('/run/preview/config.json','utf8'));
const prefix='https://ducizone.ddns.net/teacher-login-preview-api';
const sources={handout67:{kind:'identity'},substitute:{kind:'identity'}},pools=[];
for(const id of ['k56','k56demo']){const pool=new pg.Pool({connectionString:config.databases[id],max:1});pools.push(pool);sources[id]={cookieName:'izone_preview_'+id,cookiePath:'/teacher-login-preview-api/'+(id==='k56'?'mapping-api-k56':'mapping-api-demo'),native:createNativeSession({pool,kind:'reviewer',schema:'mapping'})};}
const service=createSharedTeacherSession({file:'/data/sessions.sqlite',key:Buffer.from(config.key,'hex'),sources});
const results=[];
async function fixture(identity,check){
 const jar=new Map();const q={secure:true,headers:{}},r={cookie:(name,value)=>jar.set(name,value)};
 await service.login(q,r,{...identity,email_verified:true});
 const request=async(path,expected,method='GET',body)=>{
  const reply=await fetch(prefix+path,{method,headers:{Origin:'https://tranhoangduc90.github.io','X-Izone-Csrf':'1',Cookie:[...jar].filter(([,v])=>v).map(([k,v])=>k+'='+v).join('; '),'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(15000)});
  for(const cookie of reply.headers.getSetCookie()){const pair=cookie.split(';')[0],i=pair.indexOf('=');jar.set(pair.slice(0,i),pair.slice(i+1));}
  results.push({path,expected,actual:reply.status});assert.equal(reply.status,expected,path);
 };
 try{await check(request);}finally{q.headers.cookie=[...jar].map(([k,v])=>k+'='+v).join('; ');await service.logout(q,r);}
}
try{
 const good={email:config.teacher.email,sub:config.teacher.subject};
 await fixture(good,async request=>{
  await request('/teacher-session-api/v1/restore/k56',200,'POST',{});
  await request('/mapping-api-k56/api/term-tests/teacher/options',200);
  await request('/mapping-api-k56/api/term-tests/teacher/results?classId=outside-scope',403);
  await request('/api/handout67/v1/teacher/students?class=OTHER',403);
  await request('/substitute-teacher-api/teacher/results?test=substitute-test-1-k67&class=IC2063',403);
  await request('/teacher-session-api/v1/logout',200,'POST',{});
  await request('/mapping-api-k56/api/term-tests/teacher/options',401);
  await request('/api/handout67/v1/teacher/session',401);
  await request('/substitute-teacher-api/teacher/scopes',401);
 });
 for(const identity of [{email:'unlisted-preview@example.test',sub:'unlisted-preview'}, {...good,sub:'different-google-subject-preview'}])await fixture(identity,async request=>{
  await request('/teacher-session-api/v1/restore/k56',403,'POST',{});
  await request('/api/handout67/v1/teacher/session',403);
  await request('/substitute-teacher-api/teacher/scopes',403);
 });
 console.log(JSON.stringify({ok:true,kind:'HTTPS_permissions_with_private_fixture_sessions',passed:results.length,results}));
}finally{service.close();await Promise.all(pools.map(p=>p.end()));}
