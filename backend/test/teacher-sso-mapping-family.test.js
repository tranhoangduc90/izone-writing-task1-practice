// PostgreSQL cục bộ độc lập cho mỗi sản phẩm; chỉ kiểm bảng phiên/tài khoản/quyền giả.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createSharedTeacherSession} from '../src/teacher-sso/service.js';
import {createNativeSession} from '../src/teacher-sso/native-session.js';
const products={mapping:'/mapping-api',term67:'/term-mini-k67-api',k56:'/mapping-api-k56',k56demo:'/mapping-api-demo'};
test('Mapping/Progress/Speaking, Term67, K56 thật/demo giữ bảng phiên riêng, từ chối tài khoản bị khóa và đăng xuất toàn liên kết',async t=>{
 const sources={},databases={};
 for(const [id,path] of Object.entries(products)){
  const db=new PGlite();databases[id]=db;t.after(()=>db.close());
  await db.exec(`CREATE SCHEMA mapping;
   CREATE TABLE mapping.reviewer_account(email text PRIMARY KEY,google_subject text,role text,status text,last_login_at timestamptz,updated_at timestamptz);
   CREATE TABLE mapping.reviewer_session(token_hash bytea PRIMARY KEY,reviewer_email text,google_subject text,idle_expires_at timestamptz,absolute_expires_at timestamptz,revoked_at timestamptz);
   INSERT INTO mapping.reviewer_account VALUES('teacher@example.test',NULL,'teacher','active',NULL,NULL);`);
  sources[id]={cookieName:'izone_teacher_session',cookiePath:path,native:createNativeSession({pool:db,kind:'reviewer',schema:'mapping'})};
 }
 const service=createSharedTeacherSession({file:':memory:',key:Buffer.alloc(32,3),sources});t.after(()=>service.close());
 const response=()=>({cookies:[],cookie(name,value,options){this.cookies.push({name,value,options});}}),logged=response();
 await service.login({headers:{}},logged,{email:'teacher@example.test',sub:'real-verified-sub',email_verified:true});
 const q={secure:true,headers:{cookie:logged.cookies[0].name+'='+logged.cookies[0].value}};
 for(const [id,path] of Object.entries(products)){
  const r=response();await service.restore(q,r,id);assert.equal(r.cookies[0].options.path,path);
  const identity=await sources[id].native.read(r.cookies[0].value);assert.equal(identity.google_subject,'real-verified-sub');
  assert.equal((await databases[id].query('SELECT count(*) AS n FROM mapping.reviewer_session')).rows[0].n,1);
  // Thay quyền ở chính sản phẩm phải có hiệu lực ngay, không đọc quyền chung cũ.
  await databases[id].exec("UPDATE mapping.reviewer_account SET status='inactive'");
  const denied=response();await assert.rejects(service.restore(q,denied,id),{status:403});assert.equal(denied.cookies.length,0);
  await databases[id].exec("UPDATE mapping.reviewer_account SET status='active',google_subject='different-sub'");
  await assert.rejects(service.restore(q,response(),id),{status:403});
  await databases[id].exec("UPDATE mapping.reviewer_account SET google_subject='real-verified-sub'");
 }
 await service.logout(q,response());
 for(const db of Object.values(databases))assert.equal((await db.query('SELECT count(*) AS n FROM mapping.reviewer_session')).rows[0].n,0);
});
