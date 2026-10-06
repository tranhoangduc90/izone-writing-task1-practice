import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createStore} from '../src/store.mjs';
import {createService,ORDER,FIELDS} from '../src/service.mjs';
import {createApi} from '../src/http.mjs';
import {createTeacher} from '../src/teacher.mjs';
import {contentHash} from '../src/comments.mjs';

const groups=Object.fromEntries(['A','X','B'].map(k=>[k,[{phrase:k+' phrase one',meaningVi:'cụm một'},{phrase:k+' phrase two',meaningVi:'cụm hai'}]]));
// Dữ liệu giả trên PostgreSQL local; kiểm transaction thật và đọc lại outcome.
async function fixture(t){
 const db=new PGlite();for(const file of ['001-initial.sql','002-activity-log.sql'])await db.exec(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
 let now=Date.parse('2026-10-06T00:00:00Z');const clock=()=>now,store=createStore(db,{clock});
 const roster=async()=>[{classRef:'fixture',students:[{studentRef:'s'},{studentRef:'other'}]}];
 const service=createService({store,roster,clock,secret:'s'.repeat(40),renderJob:()=> 'Prompt giả'});
 const teacher=createTeacher({db,store,roster,clock,secret:'t'.repeat(40),registry:()=>({teachers:[]}),verifyGoogleToken:async()=>({})});
 const actor={email:'fixture@izone.test',displayName:'GV thử',classes:['fixture']};
 const opened=await service.open({activity:'lesson5',classRef:'fixture',studentRef:'s'}),ref=opened.session.ref,token=opened.token;
 t.after(()=>db.close());
 const read=()=>service.read(ref,token),input=async extra=>({requestId:crypto.randomUUID(),baseVersion:(await read()).version,...extra});
 const save=async section=>service.save(ref,token,await input({responses:Object.fromEntries(FIELDS[section].map(f=>[f,'Nội dung '+f]))}));
 const check=async section=>service.check(ref,token,await input({section}));
 const attest=async section=>service.attest(ref,token,await input({section,teacherPermission:true}));
 const revise=async(field,value)=>service.revise(ref,token,await input({field,value}));
 const pass=async section=>{await save(section);await check(section);return attest(section);};
 const ready=async()=>{for(const section of ['topic','b1','a1','x1'])await pass(section);};
 return {db,store,service,teacher,actor,ref,token,read,input,save,check,attest,revise,pass,ready,advance:ms=>{now+=ms;}};
}
test('H67-APP · cho qua từng phần sau lượt chấm, đủ hai ý và một vocab mỗi ý',async t=>{
 const h=await fixture(t);await h.save('topic');await assert.rejects(()=>h.attest('topic'),/CHECK_REQUIRED/);
 await assert.rejects(()=>h.attest('b1'),/STEP_LOCKED/);
 for(const section of ORDER){if(section==='b2')await h.service.openIdea2(h.ref,h.token);if(section!=='topic')await h.save(section);await h.check(section);await h.attest(section);}
 const s=await h.read();assert.ok(ORDER.every(k=>s.steps[k].status==='passed'));assert.equal(s.steps.x2.approval.source,'student_attested_teacher_permission');
 const stored=await h.store.read(h.ref);assert.equal(stored.jobs.filter(j=>j.kind==='vocab').length,2);assert.ok(stored.jobs.filter(j=>j.kind==='grade').every(j=>j.status==='superseded'));assert.equal(s.steps.topic.history.length,0);
});
test('H67-ACK · xác nhận và Edit replay đúng request, xung đột không ghi đè',async t=>{
 const h=await fixture(t);await h.save('topic');await h.check('topic');const body=await h.input({section:'topic',teacherPermission:true});
 await h.service.attest(h.ref,h.token,body);await h.service.attest(h.ref,h.token,body);assert.equal((await h.read()).steps.topic.status,'passed');
 await assert.rejects(()=>h.service.attest(h.ref,h.token,{...body,section:'b1'}),/REQUEST_ID_CONFLICT/);
 const edit=await h.input({field:'idea1',value:'Sửa ý'});await h.service.revise(h.ref,h.token,edit);await h.service.revise(h.ref,h.token,edit);
 await assert.rejects(()=>h.service.revise(h.ref,h.token,{...edit,requestId:'other',value:'Ghi đè'}),/VERSION_CONFLICT/);
 await assert.rejects(()=>h.revise('idea1',' '),/EDIT_INVALID/);assert.equal((await h.read()).responses.idea1,'Sửa ý');
 await h.revise('idea1','Sửa tiếp cùng mốc thời gian');const log=await h.store.audit.read(h.ref);assert.equal(log.events.filter(e=>e.kind==='content_edited').length,2);
});
test('H67-LATE · cho qua khi AI chạy, raw muộn lưu hai tháng và không đảo pass',async t=>{
 const h=await fixture(t);await h.save('topic');await h.check('topic');const [job]=await h.service.claim();await h.attest('topic');h.advance(86400000*5);
 const raw=JSON.stringify({resultStatus:'needs_revision',feedback:'Nhận xét cũ'});
 assert.equal((await h.service.receive({...job,outputText:raw})).status,'superseded');assert.equal((await h.service.complete({...job,result:{resultStatus:'needs_revision',feedback:'Cũ'}})).status,'superseded');
 const reopened=await h.service.open({activity:'lesson5',classRef:'fixture',studentRef:'s'}),s=reopened.session;assert.equal(s.steps.topic.status,'passed');assert.equal(s.steps.topic.history.length,0);
 const log=await h.store.audit.read(h.ref,{jobRef:job.jobRef});assert.equal(log.detail.attempts[0].response_text,raw);assert.equal(new Date(log.detail.input.expires_at).toISOString(),'2026-12-11T00:00:00.000Z');
});
test('H67-EDIT · sửa A giữ thông qua, bản X và supersede X đang chấm; nhật ký trước sau',async t=>{
 const h=await fixture(t);for(const k of ['topic','b1','a1'])await h.pass(k);await h.save('x1');await h.check('x1');const [job]=await h.service.claim();await h.revise('a1','Điểm đầu mới');
 let s=await h.read();assert.equal(s.steps.a1.status,'passed');assert.equal(s.steps.a1.editedAfterApproval,true);assert.equal(s.responses.x1,'Nội dung x1');assert.equal(s.steps.x1.status,'revision');assert.equal((await h.service.forProcessing(job)).status,'superseded');
 await h.check('x1');await h.attest('x1');s=await h.read();assert.equal(s.steps.x1.status,'passed');
 const log=await h.store.audit.read(h.ref);assert.ok(log.events.some(e=>e.kind==='content_edited'&&e.details.after.a1==='Điểm đầu mới'));
});
test('H67-DEPENDENCY · sửa A1 không hủy chấm B2 không dùng A1',async t=>{
 const h=await fixture(t);await h.ready();await h.service.openIdea2(h.ref,h.token);await h.save('b2');await h.check('b2');const jobs=[];for(let i=0;i<2;i++)jobs.push(...await h.service.claim());const job=jobs.find(j=>j.section==='b2');assert.ok(job);
 await h.revise('a1','A1 chỉnh');assert.equal((await h.service.forProcessing(job)).status,'leased');
 await h.service.complete({...job,result:{resultStatus:'passed',feedback:'B2 phù hợp'}});assert.equal((await h.read()).steps.b2.status,'passed');
});
test('H67-VOC · Edit liên tiếp chỉ nhận vocab bản mới, không đổi ý kia',async t=>{
 const h=await fixture(t);await h.ready();const [old]=await h.service.claim();await h.service.complete({...old,result:groups});await h.service.openIdea2(h.ref,h.token);for(const k of ['b2','a2','x2'])await h.pass(k);const [v2]=await h.service.claim();await h.service.complete({...v2,result:groups});
 await h.revise('a1','A bản hai');h.advance(1100);const [v1]=await h.service.claim();await h.revise('x1','X bản ba');h.advance(1100);const [latest]=await h.service.claim();assert.notEqual(v1.jobRef,latest.jobRef);
 assert.equal((await h.service.complete({...v1,result:groups})).status,'superseded');await h.service.complete({...latest,result:groups});
 const s=await h.read();assert.equal(s.vocabulary[1].jobRef,latest.jobRef);assert.equal(s.vocabulary[2].jobRef,v2.jobRef);assert.ok(ORDER.every(k=>s.steps[k].status==='passed'));assert.equal(latest.snapshot.responses.x1,'X bản ba');
});
test('H67-COMMENT · GV bám đoạn, HV reply, replay và status không đổi version/job; Edit giữ thread',async t=>{
 const h=await fixture(t);await h.save('topic');await h.check('topic');const s=await h.read(),body={action:'create',field:'idea1',fieldHash:contentHash(s.responses.idea1),range:{start:0,end:8},body:'Làm rõ nội dung',requestId:'comment-one',expectedActor:h.actor.email};
 await h.teacher.thread(h.actor,h.ref,body);await h.teacher.thread(h.actor,h.ref,body);let current=await h.read();assert.equal(current.commentThreads.length,1);assert.equal(current.version,s.version);assert.equal(current.steps.topic.status,'pending');const thread=current.commentThreads[0];
 const reply={action:'reply',threadRef:thread.ref,body:'Em đã hiểu',requestId:'reply-one'};await h.service.replyComment(h.ref,h.token,reply);await h.service.replyComment(h.ref,h.token,reply);
 await assert.rejects(()=>h.service.replyComment(h.ref,h.token,{action:'status',threadRef:thread.ref,status:'addressed',requestId:'fake-status'}),/COMMENT_FORBIDDEN/);
 await h.teacher.thread(h.actor,h.ref,{action:'status',threadRef:thread.ref,status:'addressed',expectedCommentVersion:(await h.read()).commentVersion,requestId:'status-one',expectedActor:h.actor.email});
 await h.revise('idea1','Nội dung đã thay hoàn toàn');current=await h.read();assert.equal(current.commentThreads[0].messages.length,2);assert.equal(current.commentThreads[0].status,'addressed');
 await h.revise('idea1','Xóa trích đoạn');assert.equal((await h.read()).commentThreads[0].anchor.detached,true);assert.equal((await h.read()).commentThreads[0].originalContent,s.responses.idea1);
 await assert.rejects(()=>h.teacher.thread({...h.actor,classes:['other']},h.ref,body),/TEACHER_FORBIDDEN/);
 await assert.rejects(()=>h.teacher.thread(h.actor,h.ref,{...body,requestId:'stale'}),/COMMENT_CONTENT_CHANGED/);
 const log=await h.store.audit.read(h.ref);assert.ok(log.events.some(e=>e.kind==='comment_student'&&e.details.message.body==='Em đã hiểu'));
});
test('H67-HTTP · token phiên khác và body giả actor bị chặn ở đường thao tác mới',async t=>{
 const h=await fixture(t),server=createApi({service:h.service,origins:['http://fixture.test'],internalSecret:'i'.repeat(40)});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const other=await h.service.open({activity:'lesson5',classRef:'fixture',studentRef:'other'});
 for(const path of ['edit','attest','threads']){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/handout67/v1/sessions/${h.ref}/${path}`,{method:'POST',headers:{Authorization:'Bearer '+other.token,'Content-Type':'application/json'},body:'{}'});assert.equal(r.status,401);}
});
