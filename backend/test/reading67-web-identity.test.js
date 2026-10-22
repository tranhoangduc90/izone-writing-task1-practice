// Ca mới bảo vệ quyền đọc thật qua HTTP/SQL và lifecycle reset, không test tên hàm.
// Google/roster là fixture có thể thu hồi; không gọi hoặc ghi hệ thống thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import {createContext} from '../src/reading-listening67/authority/context.js';
import {createContextSnapshot} from '../src/reading-listening67/authority/context-contract.js';
import {createReading67WebIdentity} from '../src/reading-listening67/web-identity.js';
import {createReading67WebRouter} from '../src/reading-listening67/web-routes.js';
import {createReading67WebStore} from '../src/reading-listening67/web-store.js';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
const targets=Array.from({length:20},(_,i)=>'target.'+i);
const grader={pins:{sha256:'a'.repeat(64)},profile:{expected_target_ids:targets},inspectWeb:answers=>({parsed:{targets:Object.entries(answers).map(([target_id,source_text])=>({target_id,source_text}))},completeness:{filled_cells:Object.keys(answers).length,eligible_for_grading:Object.keys(answers).length>=16}})};
const content={code:'reading67-test',version:'v1',title:'Đề giả'};
async function setup(t){
 const db=new PGlite();t.after(()=>db.close());
 for(const name of ['web','identity'])await db.exec(await fs.readFile(new URL(`../../docs/migrations/2026-10-22-reading67-${name}.sql`,import.meta.url),'utf8'));
 let now=Date.now(),broken=false,stale=false;
 const payload={apiVersion:1,productId:'PRODUCT-TERM-MINI-K67',classes:[{erp_course_class_id:'1124',erp_class_name_snapshot:'TESTA'},{erp_course_class_id:'1131',erp_class_name_snapshot:'TESTB'}],students:[{public_id:A,erp_course_class_id:'1124',erp_student_contact_id:'91',erp_student_name_snapshot:'Trùng tên',status:'approved'},{public_id:B,erp_course_class_id:'1124',erp_student_contact_id:'92',erp_student_name_snapshot:'Trùng tên',status:'approved'},{public_id:C,erp_course_class_id:'1131',erp_student_contact_id:'93',erp_student_name_snapshot:'Người khác',status:'approved'}],memberships:[['1124','91'],['1124','92'],['1131','93']].map(([erp_course_class_id,erp_student_contact_id])=>({erp_course_class_id,erp_student_contact_id,erp_student_name_snapshot:'Tên',source_state:'active'})),accounts:[{email:'teacher@example.test',google_subject:'known-sub',display_name:'GV',role:'teacher',status:'active',can_access_all_classes:false}],access:[{reviewer_email:'teacher@example.test',erp_course_class_id:'1124'}]};
 const context=createContext({url:'http://fixture',key:'fixture',clock:()=>now,fetcher:async()=>{if(broken)throw Error('network');return new Response(JSON.stringify(createContextSnapshot(payload,stale?now-121000:now)));}});
 const identity=createReading67WebIdentity({db,context,clock:()=>now,cookiePath:'/api',allowedClassIds:['1124','1131'],verifyGoogle:async value=>{if(value==='bad-token-value')throw Error('invalid');return {email:'teacher@example.test',email_verified:value!=='unverified-token',sub:value==='wrong-subject-token'?'other-sub':'known-sub'};}});
 const store=createReading67WebStore({db,grader});const app=express();app.use('/api',createReading67WebRouter({identity,store,content,grader,authenticate:identity.authenticate}));
 return {db,store,app,payload,context,identity,advance(){now+=31000;},expire(){now+=31*86400000;},break(){broken=true;now+=31000;},stale(){stale=true;now+=31000;}};
}
const body={answers:Object.fromEntries(targets.map(id=>[id,'Bài tự viết'])),notes:'Ghi chú giữ lại',annotations:[],flags:[1]};
const scope={ownerId:A,courseId:'1124',code:content.code,version:content.version};
async function student(app,id=A,classId='1124'){return (await request(app).post('/api/student/login').send({studentRef:id,classId}).expect(200)).body;}
function result(job){return {pins:grader.pins,context:{operationId:job.jobId,sourceDigest:job.inputHash},grading:{target_results:targets.map(target_id=>({target_id,verdict:'correct'}))},feedback:{}};}

test('Nhận diện UUID/ERP/lớp: trùng tên không ghép nhầm; nhớ người không cấp quyền',async t=>{
 const f=await setup(t);
 const resolve=await request(f.app).post('/api/identity/resolve').send({identity:{authority:'erp-contact',id:'91'}}).expect(200);assert.equal(resolve.body.aliases[0].studentRef,A);assert.deepEqual(resolve.body.identity,{authority:'erp-contact',id:'91'});
 const a=await student(f.app),b=await student(f.app,B);
 await request(f.app).post('/api/student/login').send({studentRef:A,classId:'1131'}).expect(403);
 await request(f.app).post('/api/student/login').send({studentRef:A,classId:'1124',ownerId:B}).expect(400);
 const input={baseRevision:0,mutationId:randomUUID(),body};await request(f.app).put('/api/draft').set('Authorization','Bearer '+a.token).send(input).expect(200);
 const other=await request(f.app).get('/api/draft').set('Authorization','Bearer '+b.token).expect(200);assert.equal(other.body.revision,0);
 f.payload.memberships[0].source_state='missing';f.advance();await request(f.app).get('/api/draft').set('Authorization','Bearer '+a.token).expect(403);
});
test('Phiên học viên bị thu hồi, hết hạn hoặc đổi mã ERP không đọc được nháp',async t=>{
 const f=await setup(t),a=await student(f.app);await request(f.app).post('/api/student/logout').set('Authorization','Bearer '+a.token).send({}).expect(200);
 await request(f.app).get('/api/draft').set('Authorization','Bearer '+a.token).expect(401);
 const b=await student(f.app);f.payload.students[0].erp_student_contact_id='99';f.payload.memberships[0].erp_student_contact_id='99';f.advance();await request(f.app).get('/api/draft').set('Authorization','Bearer '+b.token).expect(403);
 const c=await student(f.app,B);f.expire();await request(f.app).get('/api/draft').set('Authorization','Bearer '+c.token).expect(401);
});
test('Google GV và quyền lớp: chặn subject sai, lớp khác, quyền thu hồi; chỉ xem',async t=>{
 const f=await setup(t);await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});
 for(const credential of ['bad-token-value','unverified-token'])await request(f.app).post('/api/teacher/login').send({credential,remember:true}).expect(401);
 await request(f.app).post('/api/teacher/login').send({credential:'wrong-subject-token',remember:true}).expect(403);
 const agent=request.agent(f.app);const login=await agent.post('/api/teacher/login').send({credential:'valid-token-value',remember:true}).expect(200);assert.match(login.headers['set-cookie'][0],/HttpOnly/);
 const classes=await agent.get('/api/teacher/classes').expect(200);assert.equal(classes.body.classes.length,1);
 const detail=await agent.get('/api/teacher/work/1124/'+A).expect(200);assert.equal(detail.body.readonly,true);assert.deepEqual(detail.body.draft.body,body);
 await agent.get('/api/teacher/work/1131/'+C).expect(403);
 await agent.put('/api/draft').send({baseRevision:1,mutationId:randomUUID(),body}).expect(401);
 await agent.post('/api/submit').send({revision:1,requestId:randomUUID()}).expect(401);
 f.payload.access=[];f.advance();await agent.get('/api/teacher/work/1124/'+A).expect(403);
});
test('GV đăng xuất thu hồi cookie, CSRF và TTL; không mở lại bằng cookie cũ',async t=>{
 const f=await setup(t),agent=request.agent(f.app);const login=await agent.post('/api/teacher/login').send({credential:'valid-token-value',remember:true}).expect(200);const cookie=login.headers['set-cookie'][0].split(';')[0];
 await agent.post('/api/teacher/logout').send({}).expect(403);
 await agent.post('/api/teacher/logout').set('X-Izone-Csrf','1').send({}).expect(200);
 await request(f.app).get('/api/teacher/classes').set('Cookie',cookie).expect(401);
 const fresh=await request(f.app).post('/api/teacher/login').send({credential:'valid-token-value',remember:false}).expect(200);f.expire();await request(f.app).get('/api/teacher/classes').set('Cookie',fresh.headers['set-cookie'][0].split(';')[0]).expect(401);
});
test('Nguồn quyền lỗi/cũ fail closed, không dùng cache hết tuổi hoặc lộ nội dung',async t=>{
 const f=await setup(t),a=await student(f.app);f.stale();await request(f.app).get('/api/lesson').set('Authorization','Bearer '+a.token).expect(503);
 const other=await setup(t),b=await student(other.app);other.break();await request(other.app).get('/api/lesson').set('Authorization','Bearer '+b.token).expect(503);
});
test('Reset lưu nháp cũ, retry không tạo lượt đôi; chấm lại giữ kết quả và mốc đầu',async t=>{
 const f=await setup(t);const empty=await f.store.reset({...scope,ownerId:B},{baseRevision:0,mutationId:randomUUID()});assert.equal(empty.runNo,2);assert.equal((await f.store.archives({...scope,ownerId:B})).length,1);
 await f.store.save(scope,{baseRevision:0,mutationId:randomUUID(),body});const old=await f.store.submit(scope,{revision:1,requestId:randomUUID()}),job=await f.store.claim();await f.store.finish(job,result(job));
 const first=await f.store.firstCompleted(scope),mutationId=randomUUID();const reset=await f.store.reset(scope,{baseRevision:1,mutationId});assert.equal(reset.runNo,2);assert.deepEqual(reset.body.answers,{});
 assert.equal((await f.store.reset(scope,{baseRevision:1,mutationId})).runNo,2);assert.equal((await f.store.archives(scope)).length,1);assert.deepEqual((await f.store.archives(scope))[0].body,body);
 assert.equal((await f.store.attempt(scope,old.attemptId)).status,'done');assert.deepEqual(await f.store.firstCompleted(scope),first);
 const changed=structuredClone(body);changed.answers[targets[0]]='Nội dung được sửa';await f.store.save(scope,{baseRevision:2,mutationId:randomUUID(),body:changed});const next=await f.store.submit(scope,{revision:3,requestId:randomUUID()});assert.notEqual(next.attemptId,old.attemptId);assert.equal(next.runNo,2);assert.deepEqual((await f.store.attempt(scope,old.attemptId)).snapshot,body);
 const reused=await f.store.submit(scope,{revision:3,requestId:randomUUID()});assert.equal(reused.attemptId,next.attemptId);assert.equal((await f.store.history(scope)).length,2);
});
