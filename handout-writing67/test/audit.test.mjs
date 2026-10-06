import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createStore} from '../src/store.mjs';
import {createService} from '../src/service.mjs';
import {createTeacher} from '../src/teacher.mjs';

// Native SQL trên fixture local: kiểm nội dung thực đã commit và rollback, không mock câu truy vấn.
async function fixture(t){
  const db=new PGlite();for(const name of ['001-initial.sql','002-activity-log.sql'])await db.exec(await readFile(new URL('../db/'+name,import.meta.url),'utf8'));
  t.after(()=>db.close());let now=Date.parse('2026-10-06T00:00:00Z');
  const store=createStore(db,{clock:()=>now});
  const roster=async()=>[{classRef:'fixture-c67',students:[{studentRef:'fixture-a'}]},{classRef:'other-class',students:[{studentRef:'fixture-b'}]}];
  const service=createService({store,secret:'s'.repeat(40),roster,clock:()=>now,renderJob:()=> 'Rubric giả riêng tư.'});
  const a=await service.open({activity:'lesson5',classRef:'fixture-c67',studentRef:'fixture-a'});
  const save=()=>service.save(a.session.ref,a.token,{baseVersion:0,requestId:'save',responses:{idea1:'Tốn tiền',idea2:'Hại môi trường',topicSentence:'Unnecessary purchases cause harm.'}});
  const check=()=>service.check(a.session.ref,a.token,{baseVersion:1,requestId:'check',section:'topic'});
  return {db,store,service,roster,a,save,check,clock:value=>{now=Date.parse(value);}};
}

test('L-RAW · giữ phản hồi nguyên dạng trước lỗi parse',async t=>{
  const h=await fixture(t);await h.save();await h.check();const [job]=await h.service.claim();
  const outputText='```json\n{"resultStatus": ???}\n```';
  const r=await h.service.receive({...job,outputText,model:'fixture-model',httpStatus:200});assert.equal(r.status,'queued');
  const log=await h.store.audit.read(h.a.session.ref,{jobRef:job.jobRef});
  assert.equal(log.detail.attempts[0].response_text,outputText);assert.equal(log.detail.attempts[0].error_code,'AI_JSON_INVALID');
  assert.equal(log.detail.input.snapshot.responses.topicSentence,'Unnecessary purchases cause harm.');
  assert.equal(log.detail.input.prompt,undefined);
  assert.ok(!JSON.stringify(log).includes(job.leaseToken));assert.ok(!JSON.stringify(log).includes(h.a.token));
  const replay=await h.service.receive({...job,outputText});assert.equal(replay.status,'queued');
  assert.equal((await h.db.query('SELECT count(*)::int AS n FROM handout67.grading_attempt')).rows[0].n,1);
});

test('L-ATOMIC · trạng thái và input/event cùng commit hoặc cùng rollback',async t=>{
  const h=await fixture(t);await h.db.exec('DROP TABLE handout67.activity_event');
  await assert.rejects(h.save());
  let s=await h.store.read(h.a.session.ref);assert.equal(s.version,0);assert.equal(s.responses.idea1,'');
  await h.db.exec(await readFile(new URL('../db/002-activity-log.sql',import.meta.url),'utf8'));await h.save();
  await h.db.exec('DROP TABLE handout67.grading_input CASCADE');
  await assert.rejects(h.check());s=await h.store.read(h.a.session.ref);
  assert.equal(s.steps.topic.status,'draft');assert.equal(s.jobs.length,0);assert.equal(s.responses.idea1,'Tốn tiền');
});

test('L-RETENTION · đủ hai tháng lịch và không xóa bài',async t=>{
  const h=await fixture(t);h.clock('2023-12-31T08:15:00Z');
  const who=await h.service.open({activity:'lesson5',classRef:'other-class',studentRef:'fixture-b'});
  await h.service.save(who.session.ref,who.token,{baseVersion:0,requestId:'save-old',responses:{idea1:'Ý một',idea2:'Ý hai',topicSentence:'Topic'}});
  await h.service.check(who.session.ref,who.token,{baseVersion:1,requestId:'check-old',section:'topic'});
  const [job]=await h.service.claim();await h.service.receive({...job,outputText:JSON.stringify({resultStatus:'passed',feedback:'Nhận xét giả đã ghi.'})});
  const expires=(await h.db.query('SELECT expires_at FROM handout67.grading_input WHERE job_ref=$1',[job.jobRef])).rows[0].expires_at.toISOString();
  assert.equal(expires,'2024-02-29T08:15:00.000Z');
  assert.equal(await h.store.audit.cleanup(Date.parse('2024-02-29T08:14:59Z')),0);
  assert.equal((await h.store.audit.read(who.session.ref,{jobRef:job.jobRef})).detail.attempts.length,1);
  assert.equal(await h.store.audit.cleanup(Date.parse('2024-02-29T08:15:00Z')),3);
  assert.equal((await h.store.audit.read(who.session.ref,{jobRef:job.jobRef})).detail,null);
  const kept=await h.store.read(who.session.ref);assert.equal(kept.responses.topicSentence,'Topic');assert.equal(kept.steps.topic.history[0].feedback,'Nhận xét giả đã ghi.');
  assert.equal(await h.store.audit.cleanup(Date.parse('2024-02-29T08:15:00Z')),0);
});

test('L-OWNER · log đúng lớp và phiên',async t=>{
  const h=await fixture(t);await h.save();await h.check();
  const other=await h.service.open({activity:'lesson5',classRef:'other-class',studentRef:'fixture-b'});
  const registry={clientId:'fixture.apps.googleusercontent.com',teachers:[{email:'fixture@example.edu',displayName:'Giảng viên giả',subject:'fixture-sub',classes:['fixture-c67']}]};
  const teacher=createTeacher({db:h.db,store:h.store,roster:h.roster,secret:'t'.repeat(40),registry:()=>registry,verifyGoogleToken:async()=>({sub:'fixture-sub',email:'fixture@example.edu',email_verified:true,hd:'example.edu'})});
  const login=await teacher.login('fixture-google'),actor=teacher.authorize(login.token);
  await assert.rejects(teacher.activity(actor,other.session.ref),e=>e.status===403);
  const first=await teacher.activity(actor,h.a.session.ref,{limit:1});assert.equal(first.events.length,1);assert.ok(first.nextCursor);
  const second=await teacher.activity(actor,h.a.session.ref,{limit:1,before:first.nextCursor});
  assert.notEqual(first.events[0].event_key,second.events[0].event_key);
  await assert.rejects(teacher.activity(actor,h.a.session.ref,{before:'invalid'}),e=>e.status===400);
  assert.equal((await teacher.activity(actor,h.a.session.ref,{jobRef:crypto.randomUUID()})).detail,null);
});

test('L-CLEANUP · dọn nhiều lô sự kiện độc lập không dừng giả ở lô đầu',async t=>{
  const h=await fixture(t);
  await h.db.query(`INSERT INTO handout67.activity_event(event_key,session_ref,class_ref,student_ref,kind,event_at,expires_at)
    SELECT 'expired-'||n,$1,'fixture-c67','fixture-a','responses_saved','2024-01-01T00:00:00Z','2024-03-01T00:00:00Z' FROM generate_series(1,201) n`,[h.a.session.ref]);
  const now=Date.parse('2026-10-06T00:00:00Z');
  assert.equal(await h.store.audit.cleanup(now,100),100);
  assert.equal(await h.store.audit.cleanup(now,100),100);
  assert.equal(await h.store.audit.cleanup(now,100),1);
  assert.equal(await h.store.audit.cleanup(now,100),0);
  assert.equal((await h.store.read(h.a.session.ref)).responses.idea1,'');
});
