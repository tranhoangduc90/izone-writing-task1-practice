// Kiểm ranh giới phiên chung bằng dữ liệu giả; không gọi Google, AI hoặc Portal thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSharedTeacherSession} from '../src/teacher-sso/service.js';
import {createSharedTeacherVerifier} from '../src/teacher-sso/consumer.js';
import {createRemoteNative} from '../src/teacher-sso/remote-session.js';
const q=cookie=>({secure:true,headers:{cookie}});
const response=()=>({cookies:[],cookie(name,value,options){this.cookies.push({name,value,options});}});
function fixture(t){
 let now=Date.parse('2026-10-23T00:00:00Z');
 const sources={handout67:{kind:'identity',cookieName:'old_handout',cookiePath:'/api/handout67/v1/teacher'},substitute:{kind:'identity'}};
 const service=createSharedTeacherSession({file:':memory:',key:Buffer.alloc(32,9),sources,clock:()=>now});t.after(()=>service.close());
 return {service,advance:ms=>now+=ms};
}
test('Phiên Google đã xác minh mở hai consumer, gia hạn 90 ngày và thu hồi ngay',async t=>{
 const {service,advance}=fixture(t),r=response();
 await service.login(q(''),r,{sub:'google-sub',email:'Teacher@example.test',email_verified:true});
 const cookie=r.cookies[0].name+'='+r.cookies[0].value;
 for(const id of ['handout67','substitute']){
  const out=response();assert.deepEqual(await service.restore(q(cookie),out,id),{ok:true});assert.equal(out.cookies[0].options.maxAge,90*86400000);
 }
 assert.equal(service.inspect(q(cookie)).email,'teacher@example.test');
 advance(80*86400000);await service.restore(q(cookie),response(),'handout67');advance(20*86400000);
 assert.equal(service.inspect(q(cookie)).google_subject,'google-sub');
 await service.logout(q(cookie),response());assert.throws(()=>service.inspect(q(cookie)),{status:401});
});
test('Không xác minh email, cookie giả, cookie trùng và hết hạn đều không cấp danh tính',async t=>{
 const {service,advance}=fixture(t),r=response();
 await assert.rejects(service.login(q(''),r,{sub:'s',email:'a@b.test',email_verified:false}),{status:401});
 await service.login(q(''),r,{sub:'s',email:'a@b.test',email_verified:true},false);
 const cookie=r.cookies[0].name+'='+r.cookies[0].value;
 assert.equal(r.cookies[0].options.maxAge,undefined);
 for(const c of ['izone_teacher_shared=forged',cookie+'; '+cookie])assert.throws(()=>service.inspect(q(c)),{status:401});
 advance(3600000);assert.throws(()=>service.inspect(q(cookie)),{status:401});
});
test('Consumer chỉ gửi cookie chung, không gửi cookie sản phẩm hoặc bearer; không cache thu hồi',async()=>{
 let revoked=false,calls=0;
 const verify=createSharedTeacherVerifier({url:'http://identity.internal/internal/identity/handout67',key:'private-fixture-key',fetcher:async(url,options)=>{
  calls++;assert.equal(options.headers.Cookie,'izone_teacher_shared='+'a'.repeat(43));assert.equal(options.headers.Authorization,undefined);
  return {ok:!revoked,status:revoked?401:200,json:async()=>({email:'t@example.test',google_subject:'sub'})};
 }});
 const request={headers:{cookie:'old_handout=secret; izone_teacher_shared='+'a'.repeat(43),authorization:'Bearer ignored'}};
 assert.equal((await verify(request)).sub,'sub');revoked=true;await assert.rejects(verify(request),{status:401});assert.equal(calls,2);
 await assert.rejects(verify({headers:{cookie:request.headers.cookie+'; izone_teacher_shared='+'a'.repeat(43)}}),{status:401});
});
test('Consumer báo lỗi nguồn và JSON sai; không dùng cookie cũ để vượt xác minh',async()=>{
 const request={headers:{cookie:'izone_teacher_shared='+'a'.repeat(43)}};
 for(const result of [{ok:false,status:503},{ok:true,status:200,json:async()=>({email:'x'})}]){
  const verify=createSharedTeacherVerifier({url:'http://internal/',key:'key',fetcher:async()=>result});
  await assert.rejects(verify(request),{status:503});
 }
});
test('Tiếp nhận cookie Handout cũ chỉ sau khi nguồn gốc xác minh email/chữ ký',async()=>{
 const now=Date.now(),body=Buffer.from(JSON.stringify({email:'t@example.test',sub:'s',exp:now+43200000})).toString('base64url');
 let authorized=false;
 const native=createRemoteNative({url:'http://handout.internal/teacher/legacy-session',cookieName:'old',bootstrapKey:'key',clock:()=>now,fetcher:async()=>({ok:authorized,status:authorized?200:401,json:async()=>({reviewer:{email:'t@example.test'}})})});
 assert.equal(await native.read(body+'.'+'a'.repeat(43)),null);authorized=true;
 assert.equal((await native.read(body+'.'+'a'.repeat(43))).google_subject,'s');
});
