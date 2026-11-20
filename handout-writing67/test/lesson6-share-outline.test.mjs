import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { createApi } from '../src/http.mjs';
import { createService } from '../src/service.mjs';
import { createStore } from '../src/store.mjs';
import { createLesson4ShareWorker } from '../src/writing-lesson4-share.mjs';
import { verifyLesson6Conversation } from '../src/writing-lesson6-share.mjs';
import { LESSON6_SHARE_POLICY, LESSON6_STARTER, LESSON6_TOPIC } from '../src/writing-lesson6.mjs';

const conversation = { messages: [
  ['user', 'Bài luyện thử'], ['assistant', LESSON6_TOPIC],
  ['user', 'Nêu mức độ đồng ý. Công nghệ là bối cảnh cho việc truy cập và trao đổi thông tin nhanh, thiếu kiểm soát.'],
  ['assistant', 'Brainstorm lợi ích và mối nguy.'],
  ['user', 'Người dân có thể nhận tin cảnh báo sớm, nhưng tin sai dễ lan.'],
  ['assistant', 'Bạn chọn hai ý cho mỗi mặt?'],
  ['user', 'Em chọn cảnh báo lũ, hướng dẫn học, tin đồn lan rộng và dữ liệu bị phát tán.'],
  ['assistant', 'Bạn chọn quan điểm nào?'], ['user', 'Em đồng ý.'],
  ['assistant', 'Thân 1 nói lợi ích nhận cảnh báo và tìm hướng dẫn. Thân 2 bảo vệ quan điểm qua tin đồn và dữ liệu bị phát tán.'],
].map(([role,text],id)=>({id:'m'+id,role,text})) };
const evidence = (id,quote) => ({id:'m'+id,quote});
const milestones = [
  { stage:'analysis',answers:[evidence(2,'Nêu mức độ đồng ý')] },
  { stage:'brainstorm',answers:[evidence(4,'tin cảnh báo sớm, nhưng tin sai dễ lan')] },
  { stage:'ideas',benefits:[evidence(6,'cảnh báo lũ'),evidence(6,'hướng dẫn học')],dangers:[evidence(6,'tin đồn lan rộng'),evidence(6,'dữ liệu bị phát tán')] },
  { stage:'opinion',answers:[evidence(8,'Em đồng ý')] },
  { stage:'summary',id:'m9' },
];

test('Lesson 6 verifies selection evidence and a summary after the final stance', async () => {
  const verify = list => verifyLesson6Conversation(conversation,async()=>({milestones:list}));
  assert.equal((await verify(milestones)).status,'accepted');
  assert.equal((await verify(milestones.filter(item=>item.stage!=='ideas'))).stage,'ideas');
  assert.equal((await verify(milestones.map(item=>item.stage==='summary'?{...item,id:'m7'}:item))).stage,'summary');
  await assert.rejects(verify(milestones.map(item=>item.stage==='ideas'?{...item,dangers:[evidence(7,'quan điểm'),evidence(6,'dữ liệu bị phát tán')]}:item)),{code:'SHARE_EVIDENCE_INVALID'});
});

test('Lesson 6 HTTP opens one-idea Check after Share and projects coverage of current results', async t => {
  const db = new PGlite();
  for (const file of ['001-initial.sql','002-activity-log.sql']) {
    await db.exec(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
  }
  const store = createStore(db);
  const lesson = { activity:'lesson6',outlineOnly:true,handoutMode:'two-bodies-v1',sharePolicy:LESSON6_SHARE_POLICY,
    workflowMode:'whole-chain-v1',topic:LESSON6_TOPIC,promptVersion:'lesson6-rubric-v1' };
  const service = createService({store,lessons:{lesson6:lesson},secret:'session-secret'.padEnd(40,'x'),
    roster:async()=>[{classRef:'IC9999',students:[{studentRef:'qa'}]}]});
  const entryKey = 'writing-entry'.padEnd(40,'x');
  const api = createApi({service,origins:[],internalSecret:'internal-secret'.padEnd(40,'x'),writingEntryKey:entryKey});
  await new Promise(resolve=>api.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>api.close(resolve));await db.close();});
  const base = 'http://127.0.0.1:'+api.address().port+'/api/handout67/v1';
  const call = async (path,method,token,body) => {
    const response = await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body&&JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const source = {classRef:'IC9999',studentRef:'qa',assignmentId:'hw-k67-writing-lesson6-9999',contentVersion:1};
  const launch = {activity:'lesson6',classRef:source.classRef,studentRef:source.studentRef,writingEntry:{assignmentId:source.assignmentId,contentVersion:1}};
  assert.equal((await call('/sessions','POST',null,launch)).status,403);
  const opened = await call('/sessions','POST',entryKey,launch);
  assert.equal(opened.status,201);
  const {token,session} = opened.body;
  const send = (path,method,body) => call('/sessions/'+session.ref+path,method,token,body);
  const progress = async () => (await call('/integrations/homework/lesson6/progress','POST',entryKey,source)).body.progress;
  const save = (baseVersion,responses) => send('/responses','PUT',{requestId:'save-'+baseVersion,baseVersion,responses});
  const check = (baseVersion,bodyIndex) => send('/checks','POST',{requestId:'grade-'+baseVersion,baseVersion,section:'body'+bodyIndex+'_topic',bodyIndex});
  assert.equal((await save(0,{stance:'agree'})).body.error,'PRACTICE_NOT_ACCEPTED');
  assert.equal((await check(0,1)).body.error,'PRACTICE_NOT_ACCEPTED');
  const fullUrl = 'https://chatgpt.com/share/00000000-0000-4000-8000-000000000006';
  const worker = createLesson4ShareWorker({store,activity:'lesson6',verify:verifyLesson6Conversation,
    readShare:async url=>url===LESSON6_STARTER?{messages:conversation.messages.slice(0,2)}:conversation,
    analyze:async()=>({milestones})});
  for(const [url,status] of [[LESSON6_STARTER,'rejected'],[fullUrl,'accepted']]){
    assert.equal((await send('/practice','POST',{requestId:'share-'+status,url})).status,202);
    assert.equal(await worker(),true);
    assert.equal((await send('/practice','GET')).body.practice.status,status);
  }
  const firstIdea='Nhận ngay cảnh báo lũ để tránh đường nguy hiểm';
  assert.equal((await save(0,{stance:'agree',body1_topicSentence:'Tiếp cận thông tin giúp gia đình chủ động bảo vệ mình.',body1_idea1:firstIdea})).status,200);
  assert.equal((await check(1,1)).status,202);
  const [first] = await service.claim();
  await service.complete({...first,result:{resultStatus:'passed',direction:'disagree',feedback:'Ý rõ.',coverage:{
    access:{field:'body1_topicSentence',quote:'Tiếp cận thông tin'},rapid:{field:'body1_idea1',quote:'Nhận ngay'},
  }}});
  assert.deepEqual((await progress()).bodies.map(body=>body.passed),[true,false]);
  const secondIdea='Chuyển tiếp tin đồn chưa kiểm chứng khiến gia đình hoang mang';
  assert.equal((await save(1,{body2_topicSentence:'Thông tin sai lan truyền sẽ gây tác hại lớn hơn.',body2_idea1:secondIdea,body2_idea2:'Dữ liệu cá nhân được gửi ngoài ý muốn'})).status,200);
  assert.equal((await check(2,2)).status,202);
  const [second] = await service.claim();
  await service.complete({...second,result:{resultStatus:'passed',direction:'agree',feedback:'Làm rõ mối nguy.',coverage:{
    exchange:{field:'body2_idea1',quote:'Chuyển tiếp'},uncontrolled:{field:'body2_idea1',quote:'chưa kiểm chứng'},
  }}});
  assert.equal((await progress()).completed,true);
  const revised = await save(2,{body2_idea2:'Dữ liệu riêng tư lan ngoài phạm vi người gửi dự tính'});
  assert.deepEqual((await progress()).bodies.map(body=>body.passed),[true,false]);
  assert.equal(revised.body.session.steps.body2_topic.history.length,1);
});
