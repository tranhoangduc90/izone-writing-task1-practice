// HTTP thật trên loopback, cookie thật; Google giả chỉ tại ranh giới xác minh chữ ký.
import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {createTeacherSsoApp} from '../src/teacher-sso/http-app.js';
import {createSharedTeacherSession} from '../src/teacher-sso/service.js';
const origin='https://tranhoangduc90.github.io';
function fixture(t){
 const sources={handout67:{kind:'identity',googleClientId:'handout.apps.googleusercontent.com'},substitute:{kind:'identity',googleClientId:'substitute.apps.googleusercontent.com'}};
 const service=createSharedTeacherSession({file:':memory:',key:Buffer.alloc(32,1),sources});t.after(()=>service.close());
 const app=createTeacherSsoApp({config:{origins:[origin]},sources,service,consumerKeys:new Map([['handout67','private-key']]),verifyGoogleToken:async(credential,audience)=>{if(credential!==audience)throw Error();return {sub:'s',email:'teacher@example.test',email_verified:true};}});
 const post=(path,body={},cookie)=>{let q=request(app).post(path).set('Origin',origin).set('X-Izone-Csrf','1').set('X-Forwarded-Proto','https').send(body);if(cookie)q=q.set('Cookie',cookie);return q;};
 return {app,post};
}
test('Login Handout → Substitute qua HTTP; cookie 90 ngày; đăng xuất thu hồi consumer',async t=>{
 const f=fixture(t),login=await f.post('/v1/login/handout67',{credential:'handout.apps.googleusercontent.com'});
 assert.equal(login.status,200);assert.deepEqual(login.body,{ok:true});const raw=login.headers['set-cookie'][0],cookie=raw.split(';')[0];
 for(const mark of ['HttpOnly','Secure','Partitioned','Path=/','SameSite=None'])assert.ok(raw.includes(mark),mark);
 // Cookie có thể được ghi sau thời điểm tạo phiên vài mili giây; không làm tròn thành quá 90 ngày.
 const maxAge=Number(raw.match(/Max-Age=(\d+)/)?.[1]);assert.ok(maxAge>=7775995&&maxAge<=7776000);
 assert.equal((await f.post('/v1/restore/substitute',{},cookie)).status,200);
 const identity=await request(f.app).post('/internal/identity/handout67').set('X-Izone-Sso-Consumer','private-key').set('Cookie',cookie);
 assert.equal(identity.status,200);assert.equal(identity.body.google_subject,'s');
 assert.equal((await f.post('/v1/logout',{},cookie)).status,200);
 assert.equal((await request(f.app).post('/internal/identity/handout67').set('X-Izone-Sso-Consumer','private-key').set('Cookie',cookie)).status,401);
});
test('Sai audience, email tự khai, sản phẩm lạ và consumer không có khóa đều bị chặn',async t=>{
 const f=fixture(t);
 assert.equal((await f.post('/v1/login/substitute',{credential:'handout.apps.googleusercontent.com'})).status,401);
 assert.equal((await f.post('/v1/login/substitute',{credential:'substitute.apps.googleusercontent.com',email:'forged@test'})).status,400);
 assert.equal((await f.post('/v1/login/unknown',{credential:'x'})).status,400);
 assert.equal((await request(f.app).post('/internal/identity/handout67')).status,403);
});
test('Origin/CSRF và preflight kiểm trên HTTP, không nhận đăng nhập qua GET',async t=>{
 const f=fixture(t);
 assert.equal((await request(f.app).post('/v1/logout').set('Origin',origin)).status,403);
 assert.equal((await request(f.app).post('/v1/logout').set('Origin','https://forged.test').set('X-Izone-Csrf','1')).status,403);
 const options=await request(f.app).options('/v1/login/substitute').set('Origin',origin);assert.equal(options.status,204);assert.equal(options.headers['access-control-allow-credentials'],'true');
 assert.equal((await request(f.app).get('/v1/login/substitute').set('Origin',origin).set('X-Izone-Csrf','1')).status,404);
});
