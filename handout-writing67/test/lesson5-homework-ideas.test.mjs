import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createApi} from '../src/http.mjs';
import {createService} from '../src/service.mjs';
import {createStore} from '../src/store.mjs';
import {LEGACY_LESSON5} from '../src/lessons.mjs';
import {LESSON4_SHARE_POLICY} from '../src/writing-lesson4-share.mjs';

test('Verified Homework ideas join the same Lesson 5 draft without bypassing Check or exposing it to name-only sessions', async t=>{
  const db=new PGlite();
  for(const name of ['001-initial.sql','002-activity-log.sql']){
    await db.exec(await readFile(new URL('../db/'+name,import.meta.url),'utf8'));
  }
  const store=createStore(db);
  const classRef='IC9999';
  const roster=async()=>[classRef,'IC9998'].map(ref=>({classRef:ref,students:['owner','other','partial','existing','both'].map(studentRef=>({studentRef,displayName:'Trùng tên'}))}));
  let now=Date.now();
  const settings={store,roster,clock:()=>now,secret:'fixture-secret'.repeat(3),renderJob:()=> 'Fixture prompt',
    lessons:{lesson4:{activity:'lesson4',outlineOnly:true,handoutMode:'two-bodies-v1',workflowMode:'whole-chain-v1',
        sharePolicy:LESSON4_SHARE_POLICY,promptVersion:'lesson4-rubric-v1'},
      lesson5:{...LEGACY_LESSON5,classes:[classRef,'IC9998']}}};
  const service=createService({...settings,lesson5HomeworkImport:true});
  const writingEntryKey='fixture-writing-entry',internalSecret='fixture-queue';
  const server=createApi({service,origins:['https://pages.example.test'],writingEntryKey,internalSecret});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();});
  async function call(path,{method='GET',body,token,bridge=false,etag}={}){
    const reply=await fetch('http://127.0.0.1:'+server.address().port+'/api/handout67/v1'+path,{
      method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:'Bearer '+token}:{}),
        ...(bridge?{'X-Handout67-Writing-Entry':writingEntryKey}:{}),...(etag?{'If-None-Match':etag}:{})},
      body:body?JSON.stringify(body):undefined
    });
    return {status:reply.status,etag:reply.headers.get('etag'),body:reply.status===304?null:await reply.json()};
  }
  async function seedSource(studentRef,second='Tăng rác thải khó xử lý',accepted=true){
    const opened=await call('/sessions',{method:'POST',token:writingEntryKey,body:{activity:'lesson4',classRef,studentRef,
      writingEntry:{assignmentId:'hw-k67-writing-lesson4-1234',contentVersion:1}}});
    assert.equal(opened.status,201);
    const {session,token}=opened.body;
    await store.edit(session.ref,s=>{
      s.practice={id:randomUUID(),status:accepted?'accepted':'rejected',policy:LESSON4_SHARE_POLICY,queuedAt:now};
      Object.assign(s.responses,{body1_idea1:'Lý do vì quảng cáo',body1_idea2:'Lý do vì giảm giá',
        body2_idea1:'Nguồn tài chính',body2_idea2:second,body2_topicSentence:'Thông điệp nguồn'});
      s.version++;
    });
    return {ref:session.ref,token};
  }
  const open=(studentRef,extra={},token)=>call('/sessions',{method:'POST',token,body:{activity:'lesson5',classRef,studentRef,...extra}});
  const save=(s,token,responses)=>call('/sessions/'+s.ref+'/responses',{method:'PUT',token,body:{baseVersion:s.version,requestId:randomUUID(),responses}});
  const owner=await seedSource('owner');
  const sourcePath='/sessions/'+owner.ref;
  assert.equal((await call(sourcePath,{token:owner.token})).status,403);
  const proof=await call(sourcePath,{token:owner.token,bridge:true});
  assert.ok(proof.body.lesson5IdeaTicket);
  const extra={lesson5IdeaTicket:proof.body.lesson5IdeaTicket};
  assert.equal((await open('other',extra)).status,403);
  assert.equal((await open('owner',{...extra,classRef:'IC9998'})).status,403);
  assert.equal((await open('owner',{lesson5IdeaTicket:proof.body.lesson5IdeaTicket+'x'})).status,403);

  const manual=await open('owner');
  assert.equal(manual.body.session.responses.idea1,'');
  const prior=await save(manual.body.session,manual.body.token,{idea1:'Bản học viên đang nhập'});
  assert.equal(prior.status,200);
  const target=await open('owner',extra);
  assert.equal(target.status,201);
  const {session,token}=target.body;
  assert.equal(session.ref,manual.body.session.ref);
  assert.equal(session.responses.idea1,'Bản học viên đang nhập');
  assert.equal(session.responses.idea2,'Tăng rác thải khó xử lý');
  assert.equal(session.responses.topicSentence,'');
  assert.deepEqual(session.lesson5IdeaSource.fields,['idea2']);
  assert.equal(session.steps.topic.status,'draft');
  assert.equal((await open('owner')).status,403);
  assert.equal((await open('owner',{},token)).body.session.ref,session.ref);
  const read=await call('/sessions/'+session.ref,{token});
  assert.equal(read.body.session.responses.idea2,session.responses.idea2);
  assert.equal((await call('/sessions/'+session.ref,{token:manual.body.token,etag:read.etag})).status,403);
  assert.equal((await save(session,manual.body.token,{idea2:'Không có quyền'})).status,403);
  assert.equal((await open('owner',extra)).body.session.version,session.version);
  assert.equal((await createService(settings).open({activity:'lesson5',classRef,studentRef:'owner',...extra})).session.ref,session.ref);

  const updated=await save(session,token,{topicSentence:'Mua đồ không cần gây hại tài chính và môi trường.'});
  const check=(section,version)=>call('/sessions/'+session.ref+'/checks',{method:'POST',token,
    body:{section,baseVersion:version,requestId:randomUUID()}});
  assert.equal((await check('b1',updated.body.session.version)).status,409);
  const topic=await check('topic',updated.body.session.version);
  assert.equal(topic.status,202);
  const claimed=(await call('/internal/jobs/claim',{method:'POST',token:internalSecret,body:{}})).body.jobs[0];
  assert.equal(claimed.snapshot.responses.idea2,'Tăng rác thải khó xử lý');
  assert.equal((await call('/internal/jobs/'+claimed.jobRef+'/complete',{method:'POST',token:internalSecret,
    body:{...claimed,result:{resultStatus:'passed',feedback:'Hai ý phù hợp với câu chủ đề.'}}})).status,200);
  assert.equal((await open('owner',{},token)).body.session.steps.topic.status,'passed');
  const audited=await db.query("SELECT details FROM handout67.activity_event WHERE kind='lesson5_homework_ideas_applied'");
  assert.equal(audited.rows.length,1);
  assert.deepEqual(audited.rows[0].details.fields,['idea2']);
  assert.equal(JSON.stringify(audited.rows).includes('rác thải'),false);

  const notAccepted=await seedSource('other','',false);
  assert.equal((await call('/sessions/'+notAccepted.ref,{token:notAccepted.token,bridge:true})).body.lesson5IdeaTicket,undefined);
  assert.equal((await open('other')).body.session.responses.idea2,'');
  const partial=await seedSource('partial','');
  const p=(await call('/sessions/'+partial.ref,{token:partial.token,bridge:true})).body.lesson5IdeaTicket;
  const partialTarget=await open('partial',{lesson5IdeaTicket:p});
  assert.equal(partialTarget.body.session.responses.idea1,'Nguồn tài chính');
  assert.equal(partialTarget.body.session.responses.idea2,'');
  await store.edit(partial.ref,s=>{s.version++;});
  assert.equal((await open('partial',{lesson5IdeaTicket:p})).status,409);

  const both=await seedSource('both');
  const bothTicket=(await call('/sessions/'+both.ref,{token:both.token,bridge:true})).body.lesson5IdeaTicket;
  const bothTarget=(await open('both',{lesson5IdeaTicket:bothTicket})).body.session;
  assert.deepEqual([bothTarget.responses.idea1,bothTarget.responses.idea2],['Nguồn tài chính','Tăng rác thải khó xử lý']);
  assert.equal(bothTarget.responses.topicSentence,'');

  const existing=(await open('existing')).body.session;
  await store.edit(existing.ref,s=>{
    s.steps.topic.status='passed';
    s.responses.idea1='Ý đã thông qua';
    s.responses.b1='Điểm B đang viết dở';
    s.version++;
  });
  const existingSource=await seedSource('existing');
  const existingTicket=(await call('/sessions/'+existingSource.ref,{token:existingSource.token,bridge:true})).body.lesson5IdeaTicket;
  const before=(await open('existing')).body.session;
  assert.deepEqual((await open('existing',{lesson5IdeaTicket:existingTicket})).body.session,before);
  assert.deepEqual((await open('existing')).body.session,before);
  now+=121000;
  assert.equal((await open('owner',extra)).status,403);
  assert.equal((await open('owner',{},token)).status,201);
});
