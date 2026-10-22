// Kiểm hợp đồng phiên dùng chung: không phụ thuộc Google thật hoặc dữ liệu học viên.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createSharedTeacherSession} from '../src/teacher-sso/service.js';
import {createNativeSession,digest} from '../src/teacher-sso/native-session.js';
const DAY=86400000,token='a'.repeat(43),email='teacher@example.test',sub='verified-sub';
function fixture(){
 let now=Date.parse('2026-10-22T00:00:00Z');
 const rows=new Map([[digest(token),{email,google_subject:sub,expires_at:new Date(now+90*DAY).toISOString(),absolute_expires_at:new Date(now+365*DAY).toISOString(),remembered:true}]]);
 const native={read:async value=>{const row=rows.get(digest(value));return row&&Date.parse(row.expires_at)>now?row:null;},issue:async(value,row)=>{rows.set(digest(value),row);return true;},revokeHash:async hash=>rows.delete(hash)};
 const sources={reading:{native,cookieName:'reading_teacher',cookiePath:'/reading/api'},materials:{native,cookieName:'reading67_teacher',cookiePath:'/materials/api'}};
 const service=createSharedTeacherSession({file:':memory:',key:Buffer.alloc(32,7),sources,clock:()=>now});
 const q=cookie=>({secure:true,headers:{cookie}}),response=()=>({cookies:[],cookie(name,value,options){this.cookies.push({name,value,options});}});
 return {service,rows,native,q,response,advance:days=>now+=days*DAY,now:()=>now};
}
test('Reading cookie opens Materials; no identity/token in JSON; all cookies are private',async()=>{
 const f=fixture(),r=f.response();assert.deepEqual(await f.service.bridge(f.q('reading_teacher='+token),r,'reading'),{ok:true});
 const shared=r.cookies[0];assert.equal(shared.options.path,'/');assert.equal(shared.options.httpOnly,true);assert.equal(shared.options.secure,true);assert.equal(shared.options.partitioned,true);assert.equal(shared.options.maxAge,90*DAY);
 const next=f.response();await f.service.restore(f.q(shared.name+'='+shared.value),next,'materials');
 assert.equal((await f.native.read(next.cookies[0].value)).email,email);assert.equal(next.cookies[0].options.path,'/materials/api');f.service.close();
});
test('90 idle days slide on use, 365 absolute days never extend',async()=>{
 const f=fixture(),r=f.response();await f.service.bridge(f.q('reading_teacher='+token),r,'reading');const cookie=r.cookies[0].name+'='+r.cookies[0].value;
 for(const step of [80,80,80,80]){f.advance(step);await f.service.restore(f.q(cookie),f.response(),'materials');}
 f.advance(44);const last=f.response();await f.service.restore(f.q(cookie),last,'materials');assert.equal(last.cookies[0].options.maxAge,DAY);
 f.advance(1);await assert.rejects(f.service.restore(f.q(cookie),f.response(),'materials'),{code:'SSO_LOGIN_REQUIRED'});f.service.close();
});
test('Unused session expires after 90 days; invalid/duplicate cookies cannot authenticate',async()=>{
 const f=fixture(),r=f.response();await f.service.bridge(f.q('reading_teacher='+token),r,'reading');const c=r.cookies[0];f.advance(90);
 for(const cookie of [c.name+'='+c.value,'izone_teacher_shared=forged','reading_teacher='+token+'; reading_teacher='+token])await assert.rejects(cookie.startsWith('reading')?f.service.bridge(f.q(cookie),f.response(),'reading'):f.service.restore(f.q(cookie),f.response(),'materials'),{status:401});f.service.close();
});
test('Do not remember stays one hour and does not set a persistent cookie',async()=>{
 const f=fixture();f.rows.get(digest(token)).remembered=false;const r=f.response();await f.service.bridge(f.q('reading_teacher='+token),r,'reading');assert.equal(r.cookies[0].options.maxAge,undefined);
 const c=r.cookies[0].name+'='+r.cookies[0].value;f.advance(1/24);await assert.rejects(f.service.restore(f.q(c),f.response(),'materials'),{status:401});f.service.close();
});
test('Explicit login without remember replaces an older remembered shared session',async()=>{
 const f=fixture(),r=f.response();await f.service.bridge(f.q('reading_teacher='+token),r,'reading');
 const shared=r.cookies[0].name+'='+r.cookies[0].value,fresh='b'.repeat(43);
 f.rows.set(digest(fresh),{email,google_subject:sub,expires_at:new Date(f.now()+3600000).toISOString(),absolute_expires_at:new Date(f.now()+3600000).toISOString(),remembered:false});
 const out=f.response();await f.service.bridge(f.q(shared+'; reading_teacher='+fresh),out,'reading',{replace:true});
 assert.equal(out.cookies[0].options.maxAge,undefined);assert.equal(f.rows.has(digest(token)),false);
 f.advance(1/24);await assert.rejects(f.service.restore(f.q(out.cookies[0].name+'='+out.cookies[0].value),f.response(),'materials'),{status:401});f.service.close();
});
test('Logout revokes source and target, clears every cookie; old cookie cannot bootstrap again',async()=>{
 const f=fixture(),r=f.response();await f.service.bridge(f.q('reading_teacher='+token),r,'reading');const cookie=r.cookies[0].name+'='+r.cookies[0].value;
 const target=f.response();await f.service.restore(f.q(cookie),target,'materials');const out=f.response();await f.service.logout(f.q(cookie),out);
 assert.equal(f.rows.size,0);assert.ok(out.cookies.every(c=>c.value===''&&c.options.maxAge===0));
 await assert.rejects(f.service.bridge(f.q('reading_teacher='+token),f.response(),'reading'),{status:401});await assert.rejects(f.service.restore(f.q(cookie),f.response(),'materials'),{status:401});f.service.close();
});
test('Source outage is an error, denied target does not issue a cookie',async()=>{
 const f=fixture();f.native.read=async()=>{throw Error('offline');};await assert.rejects(f.service.bridge(f.q('reading_teacher='+token),f.response(),'reading'),/offline/);f.service.close();
 const g=fixture(),r=g.response();await g.service.bridge(g.q('reading_teacher='+token),r,'reading');g.native.issue=async()=>false;const target=g.response();await assert.rejects(g.service.restore(g.q(r.cookies[0].name+'='+r.cookies[0].value),target,'materials'),{status:403});assert.equal(target.cookies.length,0);g.service.close();
});
test('Logout during restore cannot resurrect a native session',async()=>{
 const f=fixture(),r=f.response();await f.service.bridge(f.q('reading_teacher='+token),r,'reading');const cookie=r.cookies[0].name+'='+r.cookies[0].value;
 let release;const wait=new Promise(resolve=>release=resolve);const normal=f.native.issue;f.native.issue=async(...args)=>{await wait;return normal(...args);};
 const restore=f.service.restore(f.q(cookie),f.response(),'materials');await f.service.logout(f.q(cookie),f.response());release();await assert.rejects(restore,{status:401});assert.equal(f.rows.size,0);f.service.close();
});
test('Native SQL adapters keep identity, enforce reviewer status/subject and revoke only session rows',async()=>{
 const db=new PGlite();await db.exec(`CREATE SCHEMA reading_practice;CREATE TABLE reading_practice.teacher_session(token_hash text PRIMARY KEY,email text,google_subject text,expires_at timestamptz,absolute_expires_at timestamptz,remembered bool);
 CREATE SCHEMA mapping;CREATE TABLE mapping.reviewer_account(email text PRIMARY KEY,google_subject text,role text,status text,last_login_at timestamptz,updated_at timestamptz);
 CREATE TABLE mapping.reviewer_session(token_hash bytea PRIMARY KEY,reviewer_email text,google_subject text,idle_expires_at timestamptz,absolute_expires_at timestamptz,revoked_at timestamptz);
 INSERT INTO mapping.reviewer_account VALUES('teacher@example.test',NULL,'teacher','active',NULL,NULL);`);
 const identity={email,google_subject:sub,remembered:true,expires_at:new Date(Date.now()+DAY).toISOString(),absolute_expires_at:new Date(Date.now()+365*DAY).toISOString()};
 for(const [kind,schema] of [['reading','reading_practice'],['reviewer','mapping']]){
  const native=createNativeSession({pool:db,kind,schema});assert.equal(await native.issue(token,identity),true);assert.equal((await native.read(token)).email,email);await native.issue(token,identity);await native.revokeHash(digest(token));assert.equal(await native.read(token),null);
 }
 const account=createNativeSession({pool:db,kind:'reviewer',schema:'mapping'});
 assert.equal(await account.issue(token,{...identity,google_subject:'different-sub'}),false);
 await db.exec("UPDATE mapping.reviewer_account SET status='inactive'");assert.equal(await account.issue(token,identity),false);assert.equal((await db.query('SELECT count(*) AS n FROM mapping.reviewer_account')).rows[0].n,1);await db.close();
});
