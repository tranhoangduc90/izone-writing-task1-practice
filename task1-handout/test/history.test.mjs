import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import request from 'supertest';
import {setup} from './helpers.mjs';
import {projectHistory} from '../src/history.mjs';
import {createService} from '../src/service.mjs';
import {createApp} from '../src/app.mjs';
function oldFixture(){
 const ref=randomUUID(),sid=randomUUID(),classRef=randomUUID(),attempt=randomUUID(),aid=randomUUID(),student=randomUUID();
 const tables={activity:[{id:9,slug:'task1-fixture'}],activity_class_scope:[{id:8,activity_id:9,public_id:classRef,class_name_snapshot:'CS-HISTORY-FAKE'}],activity_roster:[{activity_class_id:8,student_public_id:student,display_alias:'Học viên lịch sử giả'}],activity_session:[{id:sid,public_id:ref,activity_id:9,activity_class_id:8,student_public_id:student,overview:'Nội dung cũ giữ nguyên',body1:'Dàn ý cũ',body2:'Nhóm còn lại',draft1:'Bản đầu cũ',draft2:'Bản sau cũ',draft_version:5,draft2_unlocked:true,updated_at:'2026-10-24T01:00:00Z'}],session_section:[{session_id:sid,section_key:'overview',locked:true,fail_streak:0,round_number:1}],check_attempt:[{id:aid,public_id:attempt,session_id:sid,section_key:'overview',comment_number:1,status:'completed',result_status:'passed',feedback:'Lời chấm cũ',version:2,created_at:'2026-10-24T01:00:00Z',result_artifacts:{}}],comment:[{public_id:randomUUID(),attempt_id:aid,session_id:sid,section_key:'overview',comment_number:1,status:'completed',content:'Lời chấm cũ',created_at:'2026-10-24T01:00:00Z'}],teacher_comment_thread:[],teacher_comment_message:[],provisional_student:[{pin_hash:'private-fixture-pin-hash'}]};
 return {snapshot:{capturedAt:'2026-10-25T00:00:00Z',tables},ref,classRef,attempt};
}
test('history preserves old text/comments and blocks public reading and every write',async t=>{
 const x=await setup(t),old=oldFixture(),before=JSON.stringify(old.snapshot),h=projectHistory(old.snapshot);
 const service=createService({pool:x.pool,pepper:'fixture-pepper-'.repeat(4),history:async()=>h});
 await x.pool.query('INSERT INTO task1_private.teacher_grant VALUES($1,$2,$3,true,$4::uuid[])',['fixture@invalid.test','fixture-sub','teacher',[old.classRef]]);
 const app=createApp({pool:x.pool,service,config:{origins:new Set(['http://fixture.invalid'])},verifyTeacher:async q=>{if(q.get('x-fixture')!=='teacher')throw Object.assign(Error('No session'),{status:401,code:'SSO_LOGIN_REQUIRED'});return {email:'fixture@invalid.test',sub:'fixture-sub'};}});
 await request(app).get('/api/v1/sessions/'+old.ref).expect(401);
 const read=await request(app).get('/api/v1/sessions/'+old.ref).set('x-fixture','teacher').expect(200);
 assert.equal(read.body.session.overview,'Nội dung cũ giữ nguyên');assert.equal(read.body.session.comments[0].feedback,'Lời chấm cũ');assert.equal(read.body.session.readOnly,true);assert.doesNotMatch(JSON.stringify(read.body),/pin_hash|private-fixture-pin-hash/);
 await request(app).post('/api/v1/attempts/'+old.attempt+'/retry').set('Origin','http://fixture.invalid').set('x-fixture','teacher').send({}).expect(403);
 await request(app).put('/api/v1/sessions/'+old.ref+'/draft').set('Origin','http://fixture.invalid').set('x-fixture','teacher').send({}).expect(403);
 await request(app).post('/api/v1/sessions').set('Origin','http://fixture.invalid').set('x-fixture','teacher').send({classRef:old.classRef}).expect(403);
 await x.pool.query("UPDATE task1_private.teacher_grant SET class_refs='{}'");await request(app).get('/api/v1/sessions/'+old.ref).set('x-fixture','teacher').expect(403);
 assert.equal(JSON.stringify(old.snapshot),before);
});
test('dashboard shows current roster plus authorized read-only history, student roster stays fixture-only',async t=>{
 const x=await setup(t),old=oldFixture(),h=projectHistory(old.snapshot),service=createService({pool:x.pool,pepper:'fixture-pepper-'.repeat(4),history:async()=>h});
 await x.pool.query('INSERT INTO task1_private.teacher_grant VALUES($1,$2,$3,true,$4::uuid[])',['fixture@invalid.test','fixture-sub','teacher',[x.classRef,old.classRef]]);
 const app=createApp({pool:x.pool,service,config:{origins:new Set()},verifyTeacher:async()=>({email:'fixture@invalid.test',sub:'fixture-sub'})});
 const all=await request(app).get('/api/v1/admin/live/activities/task1-fixture').expect(200);assert.equal(all.body.students.length,2);assert.equal(all.body.students.filter(x=>x.readOnly).length,1);
 const legacy=all.body.students.find(x=>x.readOnly);assert.equal(legacy.totalFields,5);assert.equal(legacy.hasStarted,true);assert.equal(legacy.savedAt,'2026-10-24T01:00:00Z');assert.ok(Date.parse(all.body.generatedAt));
 const roster=await request(app).get('/api/v1/activities/task1-fixture/roster').expect(200);assert.equal(roster.body.classes.length,1);assert.equal(roster.body.classes[0].classRef,x.classRef);
});
