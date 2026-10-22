// Kiểm nguồn V1 đang có, quyền học viên và trạng thái chưa mở lớp; không gọi hệ thống thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {createReading67OwnerSource} from '../src/reading-listening67/web-owner-source.js';
import {createReading67WebIdentity} from '../src/reading-listening67/web-identity.js';
import {createReading67WebRouter} from '../src/reading-listening67/web-routes.js';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',C='33333333-3333-4333-8333-333333333333';
function fixture(){
 const now=Date.now(),calls=[],state={denied:new Set([B]),unavailable:false,badHash:false,stale:false,duplicate:false};
 const snapshot={classes:[{erp_course_class_id:'1293',erp_class_name_snapshot:'IC2304'}],students:[A,B,C].map((public_id,i)=>({public_id,erp_course_class_id:'1293',erp_student_contact_id:String(i+1),erp_student_name_snapshot:'Học viên '+i,status:i===2?'pending_review':'approved'})),memberships:[1,2,3].map(i=>({erp_course_class_id:'1293',erp_student_contact_id:String(i),source_state:'active'}))};
 const context={snapshot:async()=>snapshot,classes:async()=>[{id:'1293',classCode:'IC2304'}],roster:async()=>snapshot.students.filter(x=>x.status==='approved').map(x=>({studentRef:x.public_id,name:x.erp_student_name_snapshot}))};
 const source=createReading67OwnerSource({context,allowedClassIds:['1293'],url:'https://owner.test',key:'test-only',clock:()=>now,fetcher:async address=>{
  const u=new URL(address),ref=u.searchParams.get('studentRef');calls.push(u.pathname+u.search);
  if(state.unavailable)return new Response('Unavailable',{status:503});
  if(state.denied.has(ref))return new Response('Forbidden',{status:403});
  const payload={apiVersion:1,classId:'1293',studentRef:ref,courseId:'classroom-IC2304',googleUserId:state.duplicate?'google-A':ref===A?'google-A':'google-B'};
  return new Response(JSON.stringify({...payload,capturedAt:new Date(now-(state.stale?120001:0)).toISOString(),sourceRevision:state.badHash?'a'.repeat(64):createHash('sha256').update(JSON.stringify(payload)).digest('hex')}));
 }});
 return {source,context,state,calls,snapshot};
}
test('V1 loại bảo lưu/thiếu mapping khỏi roster; nguồn lỗi không giả thành danh sách ít người',async()=>{
 const f=fixture();assert.deepEqual((await f.source.roster('1293')).map(x=>x.studentRef),[A]);
 await assert.rejects(f.source.member('1293',B),e=>e.code==='STUDENT_ACCESS_DENIED');
 f.state.unavailable=true;await assert.rejects(f.source.roster('1293'),e=>e.code==='OWNER_SOURCE_UNAVAILABLE');
});
test('Tra ngược bằng UUID đã duyệt và Google ID, chỉ gọi endpoint V1 thật đang có',async()=>{
 const f=fixture();const result=await f.source.resolveClassroom({courseId:'classroom-IC2304',googleUserId:'google-A'});assert.equal(result.studentRef,A);
 assert(f.calls.every(x=>x.startsWith('/v1/owner?')));
 await assert.rejects(f.source.resolveClassroom({courseId:'other-course',googleUserId:'google-A'}),e=>e.code==='OWNER_MISMATCH');
 f.state.denied.clear();f.state.duplicate=true;await assert.rejects(f.source.resolveClassroom({courseId:'classroom-IC2304',googleUserId:'google-A'}),e=>e.code==='OWNER_MISMATCH');
});
test('Snapshot chưa duyệt, sai lớp, nguồn cũ/hash hỏng bị chặn trước cấp quyền',async()=>{
 const f=fixture();await assert.rejects(f.source.member('1293',C),e=>e.code==='STUDENT_ACCESS_DENIED');assert.equal(f.calls.length,0);
 await assert.rejects(f.source.member('1124',A),e=>e.code==='STUDENT_ACCESS_DENIED');assert.equal(f.calls.length,0);
 f.state.badHash=true;await assert.rejects(f.source.member('1293',A),e=>e.code==='OWNER_MISMATCH');
 f.state.badHash=false;f.state.stale=true;await assert.rejects(f.source.member('1293',A),e=>e.code==='OWNER_MISMATCH');
});
test('Giao diện, resolve, mở phiên và phiên đang dùng đều theo điều kiện nguồn owner',async()=>{
 const f=fixture();let session,inserts=0;
 const db={async query(sql,args){if(sql.startsWith('INSERT')){inserts++;session={owner_id:args[1],course_id:args[2],erp_id:args[3]};return {rows:[]};}return {rows:session?[session]:[]};}};
 const identity=createReading67WebIdentity({db,context:f.context,ownerSource:f.source,allowedClassIds:['1293']});
 assert.deepEqual((await identity.roster('1293')).map(x=>x.studentRef),[A]);
 assert.equal((await identity.resolve({studentRef:B})).status,'missing');
 await assert.rejects(identity.loginStudent({classId:'1293',studentRef:B}),e=>e.code==='STUDENT_ACCESS_DENIED');assert.equal(inserts,0);
 const login=await identity.loginStudent({classId:'1293',studentRef:A});assert.equal(inserts,1);assert.equal(login.identity.erpId,'1');
 f.state.denied.add(A);await assert.rejects(identity.authenticate({headers:{authorization:'Bearer '+login.token}}),e=>e.code==='STUDENT_ACCESS_DENIED');
});
test('Chưa mở lớp: không tạo phiên hoặc nhận nháp; đăng ký CTA quản trị vẫn dùng được',async()=>{
 let studentCalls=0,ctaCalls=0;
 const app=express(),key='k'.repeat(40);
 app.use('/api',createReading67WebRouter({content:{title:'Materials',code:'test',version:'v1'},config:{studentsOpen:false},identity:{loginStudent(){studentCalls++;},classes:async()=>[]},authenticate:async()=>{studentCalls++;return null;},registerCta:async()=>{ctaCalls++;return {status:'verified'};},adminKey:key}));
 const result=await request(app).post('/api/student/login').send({classId:'1293',studentRef:A}).expect(423);assert.equal(result.body.error,'CLASS_NOT_OPEN');
 await request(app).get('/api/draft').expect(423);assert.equal(studentCalls,0);
 await request(app).post('/api/admin/register-cta').set('Authorization','Bearer '+key).send({doc_id:'private-test-document-123456',classroom_course_id:'test-course',coursework_id:'test-work',submission_id:'test-submission',student_id:'test-student',class_name:'IC2304'}).expect(200);assert.equal(ctaCalls,1);
});
