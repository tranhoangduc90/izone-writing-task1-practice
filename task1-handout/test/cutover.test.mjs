import test from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import {randomUUID} from 'node:crypto';
import {setup} from './helpers.mjs';
import {ownsRequest} from '../src/legacy-router.mjs';
import {createApp} from '../src/app.mjs';
test('legacy router routes by unchanged activity/session/attempt IDs and leaves other products alone',async t=>{
 const x=await setup(t);const a=await x.service.submitCheck({sessionRef:x.sessionRef,section:'overview',requestId:randomUUID(),snapshot:x.snapshot});
 for(const path of ['/api/v1/activities/task1-fixture/roster','/api/v1/admin/live/sessions/'+x.sessionRef,'/api/v1/attempts/'+a.attemptRef])assert.equal(await ownsRequest(x.pool,path),true);
 assert.equal(await ownsRequest(x.pool,'/api/v1/sessions',{activitySlug:'task1-fixture'}),true);
 for(const path of ['/api/v1/auth/session','/api/v1/admin/library','/api/v1/activities/task2-other/roster','/api/v1/attempts/'+randomUUID(),'/api/v1/admin/writing-flow/pairs/'+x.sessionRef,'/api/v1/attempts/'+x.sessionRef])assert.equal(await ownsRequest(x.pool,path),false);
});
test('live authority revocation fails closed and an admin without all-class access stays scoped',async t=>{
 const x=await setup(t);let granted=true;
 const authority={reviewer:async()=>granted?{email:'fixture@invalid.test',role:'admin',canManage:true,canAccessAllClasses:false,class_refs:[]}:null};
 const app=createApp({...x,config:{origins:new Set(['http://fixture.invalid'])},verifyTeacher:async()=>({email:'fixture@invalid.test',sub:'fixture'}),authority});
 await request(app).get('/api/v1/admin/live/sessions/'+x.sessionRef).expect(403);
 const me=await request(app).get('/api/v1/admin/me').expect(200);assert.equal(me.body.classes.length,0);granted=false;
 await request(app).get('/api/v1/auth/session').expect(403);
});
test('CSV keeps the original nine reporting columns and counts the same fields',async t=>{
 const x=await setup(t);await x.service.saveDraft({sessionRef:x.sessionRef,baseVersion:0,requestId:randomUUID(),...x.snapshot});
 const authority={reviewer:async()=>({email:'fixture@invalid.test',role:'admin',canManage:true,canAccessAllClasses:true,class_refs:[]})};
 const app=createApp({...x,config:{origins:new Set()},verifyTeacher:async()=>({email:'fixture@invalid.test',sub:'fixture'}),authority});
 const r=await request(app).get('/api/v1/admin/activities/task1-fixture/export.csv').expect(200);
 assert.equal(r.headers['content-disposition'],'attachment; filename="task1-fixture-progress.csv"');
 assert.equal(r.text.replace(/^\uFEFF/,'').split('\r\n')[0],'"Họ và tên","Lớp","Tiến trình (%)","Số ô đã làm","Số phần đã đạt","Số lần Check","Cần hỗ trợ","Học viên tạm","Trạng thái đối soát"');
 assert.match(r.text,/"Học viên thử","TASK1-THU","100","5","0","0","Không","Không","official"/u);
});
test('old frontend provisional envelope, conflict payload and closed-scope denial are preserved',async t=>{
 const x=await setup(t);const app=createApp({...x,config:{origins:new Set(['http://fixture.invalid'])}});
 const p=await request(app).post('/api/v1/activities/task1-fixture/provisional-students').set('Origin','http://fixture.invalid').send({classRef:x.classRef,displayName:'Học viên giả PIN',pin:'1234',requestId:randomUUID()}).expect(201);assert.equal(p.body.student.studentRef,p.body.studentRef);
 await x.service.saveDraft({sessionRef:x.sessionRef,baseVersion:0,requestId:randomUUID(),...x.snapshot});
 const conflict=await request(app).put('/api/v1/sessions/'+x.sessionRef+'/draft').set('Origin','http://fixture.invalid').send({baseVersion:0,requestId:randomUUID(),...x.snapshot}).expect(409);assert.equal(conflict.body.current.overview,x.snapshot.overview);
 await x.pool.query("UPDATE writing_practice.activity_class_scope SET status='closed'");
 await assert.rejects(x.service.openSession({activitySlug:'task1-fixture',classRef:x.classRef,studentRef:x.studentRef}),e=>e.code==='SESSION_NOT_ALLOWED');
});
