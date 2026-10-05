import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createStore} from '../src/store.mjs';
import {createService} from '../src/service.mjs';
import {createTeacher} from '../src/teacher.mjs';
import {createApi} from '../src/http.mjs';

// Dữ liệu giả, SQL thật trong PGlite: kiểm quyền Google/class, cookie/CSRF và góp ý đúng phiên.
async function fixture(t){
 const db=new PGlite();await db.exec(await readFile(new URL('../db/001-initial.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 const roster=async()=>[{classRef:'IC2304',className:'IC2304',students:[{studentRef:'student-a',displayName:'Học viên giả A'}]},{classRef:'other',className:'Lớp khác',students:[{studentRef:'student-b',displayName:'Học viên giả B'}]}];
 const store=createStore(db),service=createService({store,roster,secret:'s'.repeat(40)});
 let now=1000000;
 const registry={clientId:'fixture.apps.googleusercontent.com',teachers:[{email:'teacher@example.edu',displayName:'Giảng viên giả',subject:'google-sub',classes:['IC2304']}]};
 const teacher=createTeacher({db,store,roster,secret:'t'.repeat(40),registry:()=>registry,clock:()=>now,verifyGoogleToken:async token=>{if(token!=='valid-google')throw Error('invalid');return {sub:'google-sub',email:'teacher@example.edu',email_verified:true,hd:'example.edu'};}});
 const who=await service.open({activity:'lesson5',classRef:'IC2304',studentRef:'student-a'});
 const other=await service.open({activity:'lesson5',classRef:'other',studentRef:'student-b'});
 const logged=await teacher.login('valid-google'),actor=teacher.authorize(logged.token);
 return {db,service,store,teacher,who,other,registry,logged,actor,advance:ms=>now+=ms};
}
test('T-TEACHER-AUTH · Google lỗi, đổi subject, token hỏng/hết hạn và thu hồi quyền đều bị chặn',async t=>{
 const h=await fixture(t);
 await assert.rejects(h.teacher.login('fake-google'),e=>e.status===401);
 assert.throws(()=>h.teacher.authorize(h.logged.token+'x'),e=>e.status===401);
 h.advance(43200001);assert.throws(()=>h.teacher.authorize(h.logged.token),e=>e.status===401);
 h.advance(-43200001);h.registry.teachers[0].subject='another-sub';assert.throws(()=>h.teacher.authorize(h.logged.token),e=>e.status===403);
 await assert.rejects(h.teacher.login('valid-google'),e=>e.status===403);
 h.registry.teachers[0].subject='';await assert.rejects(h.teacher.login('valid-google'),e=>e.status===403);
 h.registry.teachers=[];assert.throws(()=>h.teacher.authorize(h.logged.token),e=>e.status===403);
});
test('T-TEACHER-SCOPE · lớp/bài khác bị chặn; summary/detail không lộ prompt/token/job',async t=>{
 const h=await fixture(t);
 assert.equal((await h.teacher.classes(h.actor)).length,1);
 await assert.rejects(h.teacher.summary(h.actor,'other'),e=>e.status===403);
 await assert.rejects(h.teacher.detail(h.actor,h.other.session.ref),e=>e.status===403);
 const s=await h.teacher.summary(h.actor,'IC2304');assert.equal(s.students.length,1);assert.equal(s.students[0].studentRef,'student-a');
 const detail=await h.teacher.detail(h.actor,h.who.session.ref);assert.ok(!('jobs' in detail));assert.ok(!('token' in detail));
});
test('T-TEACHER-COMMENT · đúng phần/snapshot, retry một góp ý, giữ version/bài và học viên đọc lại',async t=>{
 const h=await fixture(t),ref=h.who.session.ref;
 await h.service.save(ref,h.who.token,{baseVersion:0,requestId:'save-1',responses:{idea1:'Ý giả',idea2:'Ý giả hai',topicSentence:'Topic giả'}});
 const input={section:'topic',feedback:'Hãy giải thích rõ hơn tác hại tài chính.',requestId:'comment-stable',expectedVersion:1,expectedActor:h.actor.email};
 await h.teacher.comment(h.actor,ref,input);await h.teacher.comment(h.actor,ref,input);
 const read=await h.service.read(ref,h.who.token);assert.equal(read.teacherComments.length,1);assert.equal(read.teacherComments[0].snapshot.idea1,'Ý giả');assert.equal(read.version,1);assert.equal(read.steps.topic.status,'draft');assert.equal(read.teacherComments[0].authorEmail,undefined);
 await assert.rejects(h.teacher.comment(h.actor,h.other.session.ref,input),e=>e.status===403);
 await assert.rejects(h.teacher.comment(h.actor,ref,{...input,feedback:'Nội dung khác'}),e=>e.status===409);
 await h.service.save(ref,h.who.token,{baseVersion:1,requestId:'save-2',responses:{idea1:'Bài học viên vừa sửa'}});
 await assert.rejects(h.teacher.comment(h.actor,ref,{...input,requestId:'new-comment-stale'}),e=>e.status===409);
 assert.equal((await h.service.read(ref,h.who.token)).teacherComments.length,1);
 await assert.rejects(h.teacher.comment({...h.actor,email:'other-teacher@example.edu'},ref,{...input,requestId:'cross-tab-cookie'}),e=>e.status===401);
});
test('T-TEACHER-HTTP · cookie riêng, không nhận capability học viên; ghi phải có CSRF/origin',async t=>{
 const h=await fixture(t),server=createApi({service:h.service,teacher:h.teacher,origins:['https://fixture.example'],internalSecret:'i'.repeat(40)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}/api/handout67/v1/teacher`;
 const request=(path,options={})=>fetch(base+path,options);
 assert.equal((await request('/students?class=IC2304')).status,401);
 assert.equal((await request('/session',{headers:{Cookie:'izone_handout67_teacher='+h.who.token}})).status,401);
 const body=JSON.stringify({credential:'valid-google'});
 assert.equal((await request('/session',{method:'POST',headers:{'Content-Type':'application/json'},body})).status,403);
 const login=await request('/session',{method:'POST',headers:{Origin:'https://fixture.example','Content-Type':'application/json','X-Handout67-CSRF':'1'},body});assert.equal(login.status,200);
 const cookie=login.headers.get('set-cookie');assert.match(cookie,/HttpOnly/);assert.match(cookie,/Secure/);assert.match(cookie,/Partitioned/);assert.match(cookie,/Path=\/api\/handout67\/v1\/teacher/);
 const headers={Cookie:cookie.split(';')[0],Origin:'https://fixture.example'};
 assert.equal((await request('/students?class=IC2304',{headers})).status,200);
 assert.equal((await request('/students?class=other',{headers})).status,403);
 assert.equal((await request('/sessions/'+h.who.session.ref+'/comments',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({section:'topic',feedback:'Góp ý giả',requestId:'comment-http'})})).status,403);
});
