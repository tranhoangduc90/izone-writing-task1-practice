import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createStore} from '../src/store.mjs';
import {createService} from '../src/service.mjs';
import {createTeacher} from '../src/teacher.mjs';
import {createApi} from '../src/http.mjs';
import {LEGACY_LESSON5} from '../src/lessons.mjs';
import {contentHash} from '../src/comments.mjs';
import {validateTeacherRegistry} from '../src/teacher-registry.mjs';

// Chỉ dùng dữ liệu giả/SQL cô lập: quản trị tự nhận lớp mới, giảng viên thường giữ giới hạn.
async function fixture(t){
 const db=new PGlite();await db.exec(await readFile(new URL('../db/001-initial.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../db/002-activity-log.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 const rows=[{classRef:'IC2304',className:'Lớp A',students:[{studentRef:'student-a',displayName:'A'}]},
  {classRef:'other',className:'Lớp B',students:[{studentRef:'student-b',displayName:'B'}]}];
 const lessons={lesson5:{...LEGACY_LESSON5,classes:['IC2304','other']}};
 const store=createStore(db),roster=async()=>rows,service=createService({store,roster,lessons,secret:'s'.repeat(40)});
 const registry={clientId:'fixture.apps.googleusercontent.com',teachers:[
  {email:'admin@example.edu',displayName:'Quản trị giả',subject:'admin-sub',role:'admin',classes:[]},
  {email:'teacher@example.edu',displayName:'Giảng viên giả',subject:'teacher-sub',classes:['IC2304']} ]};
 const teacher=createTeacher({db,store,roster,lessons,registry:()=>registry,secret:'t'.repeat(40),verifyGoogleToken:async credential=>{
  if(!['admin-google','teacher-google'].includes(credential))throw Error('INVALID');
  const admin=credential==='admin-google';return {sub:admin?'admin-sub':'teacher-sub',email:admin?'admin@example.edu':'teacher@example.edu',email_verified:true,hd:'example.edu'};
 }});
 const logged=await teacher.login('admin-google'),actor=teacher.authorize(logged.token);
 const other=await service.open({activity:'lesson5',classRef:'other',studentRef:'student-b'});
 return {db,store,service,teacher,registry,rows,lessons,logged,actor,other};
}

test('Quản trị tự xem lớp hiện tại và lớp mới sau này mà không sửa danh sách quyền',async t=>{
 const h=await fixture(t),original=JSON.stringify(h.registry);
 assert.equal((await h.teacher.classes(h.actor)).length,2);
 h.rows.push({classRef:'future',className:'Lớp mở sau',students:[{studentRef:'future-student',displayName:'C'}]});
 h.lessons.lesson5.classes.push('future');
 const future=await h.service.open({activity:'lesson5',classRef:'future',studentRef:'future-student'});
 const before=JSON.stringify(await h.store.read(future.session.ref));
 assert.deepEqual((await h.teacher.classes(h.actor)).map(c=>c.classRef),['IC2304','other','future']);
 assert.equal((await h.teacher.summary(h.actor,'future')).students[0].studentRef,'future-student');
 assert.equal((await h.teacher.detail(h.actor,future.session.ref)).studentRef,'future-student');
 assert.equal(JSON.stringify(await h.store.read(future.session.ref)),before);
 assert.equal(JSON.stringify(h.registry),original);
 h.lessons.lesson5.classes.splice(h.lessons.lesson5.classes.indexOf('future'),1);
 await assert.rejects(h.teacher.detail(h.actor,future.session.ref),e=>e.status===403);
});

test('Quản trị dùng được nhận xét và trao đổi ở lớp không có trong ACL riêng, giữ phiên bản bài',async t=>{
 const h=await fixture(t),ref=h.other.session.ref;
 await h.service.save(ref,h.other.token,{baseVersion:0,requestId:'save-b',responses:{idea1:'Ý thử B'}});
 await h.teacher.comment(h.actor,ref,{section:'topic',feedback:'Góp ý giả',expectedVersion:1,requestId:'admin-comment',expectedActor:h.actor.email});
 await h.teacher.thread(h.actor,ref,{action:'create',field:'idea1',fieldHash:contentHash('Ý thử B'),body:'Trao đổi giả',requestId:'admin-thread',expectedActor:h.actor.email});
 const actual=await h.service.read(ref,h.other.token);
 assert.equal(actual.version,1);assert.equal(actual.responses.idea1,'Ý thử B');
 assert.equal(actual.teacherComments.length,1);assert.equal(actual.commentThreads.length,1);
});

test('Hạ vai quản trị có hiệu lực với cookie cũ; vẫn chặn Google sai và giảng viên thường',async t=>{
 const h=await fixture(t);
 const ordinary=await h.teacher.login('teacher-google'),actor=h.teacher.authorize(ordinary.token);
 assert.equal((await h.teacher.classes(actor)).length,1);
 await assert.rejects(h.teacher.detail(actor,h.other.session.ref),e=>e.status===403);
 h.registry.teachers[0].role='teacher';h.registry.teachers[0].classes=['IC2304'];
 const downgraded=h.teacher.authorize(h.logged.token);
 await assert.rejects(h.teacher.summary(downgraded,'other'),e=>e.status===403);
 h.registry.teachers[0].role='admin';h.registry.teachers[0].subject='not-the-verified-subject';
 assert.throws(()=>h.teacher.authorize(h.logged.token),e=>e.status===403);
 await assert.rejects(h.teacher.login('admin-google'),e=>e.status===403);
});

test('HTTP trả vai quản trị thật, không nhận quyền từ dữ liệu client hoặc token học viên',async t=>{
 const h=await fixture(t),server=createApi({service:h.service,teacher:h.teacher,origins:['https://fixture.example'],internalSecret:'i'.repeat(40)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const base=`http://127.0.0.1:${server.address().port}/api/handout67/v1/teacher`;
 const login=async credential=>{const r=await fetch(base+'/session',{method:'POST',headers:{Origin:'https://fixture.example','Content-Type':'application/json','X-Handout67-CSRF':'1'},body:JSON.stringify({credential,role:'admin'})});return {response:r,cookie:r.headers.get('set-cookie').split(';')[0],value:await r.json()};};
 const admin=await login('admin-google');assert.equal(admin.value.reviewer.role,'admin');
 assert.equal((await fetch(base+'/students?class=other',{headers:{Cookie:admin.cookie}})).status,200);
 const ordinary=await login('teacher-google');assert.equal(ordinary.value.reviewer.role,'teacher');
 assert.equal((await fetch(base+'/students?class=other',{headers:{Cookie:ordinary.cookie}})).status,403);
 assert.equal((await fetch(base+'/students?class=other',{headers:{Cookie:'izone_handout67_teacher='+h.other.token}})).status,401);
});

test('Cấu hình cũ giữ vai giáo viên; role sai hoặc subject rỗng không tự nâng quyền',()=>{
 const member={email:'fixture@example.edu',displayName:'Tên giả',subject:'verified-sub',classes:['IC2304']};
 const value=account=>({clientId:'fixture.apps.googleusercontent.com',teachers:[account]});
 assert.doesNotThrow(()=>validateTeacherRegistry(value(member),['IC2304']));
 assert.doesNotThrow(()=>validateTeacherRegistry(value({...member,role:'admin',classes:[]}),[]));
 for(const invalid of [{...member,role:'ADMIN'},{...member,role:true},{...member,subject:''},{...member,classes:['not-open']}]){
  assert.throws(()=>validateTeacherRegistry(value(invalid),['IC2304']),/TEACHER_REGISTRY_INVALID/);
 }
});
