import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createStore} from '../src/store.mjs';
import {createService} from '../src/service.mjs';
import {createTeacher} from '../src/teacher.mjs';
import {contentHash} from '../src/comments.mjs';

// Một phiên thật trong PGlite: kiểm lưu/chấm/comment hai body, không mô phỏng chính logic ghi.
const lesson={activity:'lesson11',number:11,title:'Giao thông',shortTitle:'Giao thông',topic:'Discuss trains and wider roads.',handoutMode:'two-bodies-v1',workflowMode:'whole-chain-v1',promptVersion:'lesson11-rubric-preview-v1',classes:['fixture'],bodies:[{body:1,title:'Đường tàu',objective:'BAX'},{body:2,title:'Đường bộ',objective:'BAX'}]};
async function fixture(t){
 const db=new PGlite();for(const f of ['001-initial.sql','002-activity-log.sql'])await db.exec(await readFile(new URL('../db/'+f,import.meta.url),'utf8'));
 const store=createStore(db),roster=async()=>[{classRef:'fixture',className:'Lớp thử',students:[{studentRef:'s',displayName:'HV thử'}]}];
 const service=createService({store,roster,secret:'s'.repeat(40),lessons:{lesson11:lesson},renderJob:j=>'Prompt body '+j.bodyIndex});
 const teacher=createTeacher({db,store,roster,secret:'t'.repeat(40),lessons:{lesson11:lesson},registry:()=>({teachers:[]})});
 const actor={email:'fixture@izone.test',displayName:'GV thử',classes:['fixture']};
 const opened=await service.open({activity:'lesson11',classRef:'fixture',studentRef:'s'}),ref=opened.session.ref,token=opened.token;
 const read=()=>service.read(ref,token),input=async extra=>({baseVersion:(await read()).version,requestId:crypto.randomUUID(),...extra});
 const save=async(n,section)=>{const fields=section==='topic'?['idea1','idea2','topicSentence']:['a'+section.at(-1),'x'+section.at(-1),'b'+section.at(-1)];return service.save(ref,token,await input({responses:Object.fromEntries(fields.map(f=>['body'+n+'_'+f,'Nội dung thân bài '+n+' '+f]))}));};
 const check=async(n,section)=>service.check(ref,token,await input({section:'body'+n+'_'+section,bodyIndex:n}));
 const attest=async(n,section)=>service.attest(ref,token,await input({section:'body'+n+'_'+section,bodyIndex:n,teacherPermission:true}));
 const pass=async(n,section)=>{await save(n,section);await check(n,section);await attest(n,section);};
 t.after(()=>db.close());return {db,store,service,teacher,actor,ref,token,read,input,save,check,attest,pass};
}
test('H11 · một phiên giữ hai Topic độc lập và nhận hai kết quả đảo thứ tự đúng body',async t=>{
 const h=await fixture(t),start=await h.read();assert.deepEqual(Object.keys(start.bodies),['1','2']);
 await h.save(1,'topic');await h.save(2,'topic');await h.check(1,'topic');await h.check(2,'topic');
 const [a]=await h.service.claim(),[b]=await h.service.claim();assert.deepEqual([a.bodyIndex,b.bodyIndex].sort(),[1,2]);
 await h.service.complete({...b,result:{resultStatus:'passed',feedback:'Đúng body '+b.bodyIndex}});
 await h.service.complete({...a,result:{resultStatus:'needs_revision',feedback:'Sửa body '+a.bodyIndex}});
 const s=await h.read();assert.equal(s.bodies[b.bodyIndex].steps.topic.status,'passed');assert.equal(s.bodies[a.bodyIndex].steps.topic.status,'revision');
 assert.equal((await h.service.open({activity:'lesson11',classRef:'fixture',studentRef:'s'})).session.ref,h.ref);
 await assert.rejects(()=>h.service.complete({...a,bodyIndex:b.bodyIndex,result:{resultStatus:'passed',feedback:'Sai body'}}),/CALLBACK_IDENTITY_MISMATCH/);
 const rows=await h.db.query('SELECT payload FROM handout67.session');assert.equal(rows.rows.length,1);
});
test('H11 · khóa ý 2 theo body, một body đạt không mở bước hoặc vocab body kia',async t=>{
 const h=await fixture(t);await h.pass(1,'topic');await h.pass(1,'si1');
 await assert.rejects(()=>h.service.openIdea2(h.ref,h.token,{bodyIndex:2}),/IDEA1_INCOMPLETE/);
 await h.service.openIdea2(h.ref,h.token,{bodyIndex:1});await h.pass(1,'si2');
 const s=await h.read();assert.equal(s.bodies[1].steps.si2.status,'passed');assert.equal(s.bodies[2].steps.topic.status,'draft');assert.equal(s.bodies[2].idea2Open,false);
 assert.ok(s.bodies[1].vocabulary[0]);assert.equal(s.bodies[2].vocabulary[0],undefined);assert.equal(s.completed,false);
 await assert.rejects(async()=>h.service.check(h.ref,h.token,{...await h.input({section:'body2_topic'}),bodyIndex:1}),/BODY_IDENTITY_MISMATCH/);
});
test('H11 · Edit body 2 không supersede job body 1; comment và reply đọc lại đúng body',async t=>{
 const h=await fixture(t);await h.save(1,'topic');await h.save(2,'topic');await h.check(1,'topic');const [job]=await h.service.claim();
 await h.service.revise(h.ref,h.token,await h.input({field:'body2_idea1',value:'Ý body 2 đã sửa',bodyIndex:2}));
 assert.equal((await h.service.forProcessing(job)).status,'leased');
 const s=await h.read();await h.teacher.thread(h.actor,h.ref,{action:'create',field:'body2_idea1',bodyIndex:2,fieldHash:contentHash(s.responses.body2_idea1),body:'Góp ý riêng body 2',requestId:'comment-body2',expectedActor:h.actor.email});
 let current=await h.read();assert.equal(current.bodies[1].commentThreads.length,0);assert.equal(current.bodies[2].commentThreads.length,1);
 const thread=current.bodies[2].commentThreads[0];await h.service.replyComment(h.ref,h.token,{action:'reply',threadRef:thread.ref,body:'Em trả lời',requestId:'reply-body2',bodyIndex:2});
 current=await h.teacher.detail(h.actor,h.ref);assert.equal(current.bodies[2].commentThreads[0].messages.length,2);assert.equal(current.bodies[1].responses.idea1,'Nội dung thân bài 1 idea1');
});
test('H11 · autosave hợp nhất hai body, stale version giữ nguyên dữ liệu đã lưu',async t=>{
 const h=await fixture(t);const original=await h.read();await h.save(1,'topic');await h.save(2,'topic');
 await assert.rejects(()=>h.service.save(h.ref,h.token,{baseVersion:original.version,requestId:'stale-tab',responses:{body1_idea1:'Bản cũ'}}),/VERSION_CONFLICT/);
 const s=await h.read();assert.equal(s.bodies[1].responses.idea1,'Nội dung thân bài 1 idea1');assert.equal(s.bodies[2].responses.idea1,'Nội dung thân bài 2 idea1');
});

test('H11 · hai vocab cùng số 0 vẫn tách body; Edit bỏ kết quả muộn và chỉ tạo lại đúng gói',async t=>{
 const h=await fixture(t),groups=Object.fromEntries(['A1','X1','B1','A2','X2','B2'].map(k=>[k,[{phrase:'sample phrase one',meaningVi:'cụm một'},{phrase:'sample phrase two',meaningVi:'cụm hai'}]]));
 for(const n of [1,2]){await h.pass(n,'topic');await h.pass(n,'si1');await h.service.openIdea2(h.ref,h.token,{bodyIndex:n});await h.pass(n,'si2');}
 const [v1]=await h.service.claim(),[v2]=await h.service.claim();assert.deepEqual([v1.bodyIndex,v2.bodyIndex],[1,2]);assert.equal(v1.ideaIndex,0);assert.equal(v2.ideaIndex,0);
 await h.service.complete({...v2,result:groups});await h.service.revise(h.ref,h.token,await h.input({field:'body1_x1',value:'Cơ chế body 1 mới',bodyIndex:1}));
 assert.equal((await h.service.complete({...v1,result:groups})).status,'superseded');await new Promise(r=>setTimeout(r,1100));const [fresh]=await h.service.claim();assert.equal(fresh.bodyIndex,1);await h.service.complete({...fresh,result:groups});
 const s=await h.read();assert.equal(s.completed,true);assert.equal(s.bodies[1].vocabulary[0].jobRef,fresh.jobRef);assert.equal(s.bodies[2].vocabulary[0].jobRef,v2.jobRef);
 const log=await h.store.audit.read(h.ref,{jobRef:fresh.jobRef});assert.equal(log.detail.input.snapshot.bodyIndex,1);assert.equal(log.detail.input.snapshot.responses.body1_x1,'Cơ chế body 1 mới');
});
