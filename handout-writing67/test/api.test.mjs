import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createStore } from '../src/store.mjs';
import { createService } from '../src/service.mjs';
import { createApi } from '../src/http.mjs';
import { config,rosterAdapter } from '../src/config.mjs';

const sample={idea1:'Gây khó khăn về tài chính',idea2:'Gây hại môi trường',topicSentence:'Unnecessary purchases harm personal finances and the environment.',b1:'Không còn tiền cho nhu cầu thiết yếu',a1:'Mua điện thoại mới khi máy cũ vẫn tốt',x1:'Dùng tiền dành cho thực phẩm để mua máy mới',b2:'Tăng lượng rác điện tử khó phân hủy',a2:'Thay đồ điện tử còn dùng tốt',x2:'Vứt máy cũ vẫn hoạt động để lấy mẫu mới'};
const groups={A:[{phrase:'buy unnecessary products',meaningVi:'mua đồ không cần thiết'},{phrase:'replace working devices',meaningVi:'thay thiết bị còn dùng tốt'}],X:[{phrase:'spend essential savings',meaningVi:'chi tiền tiết kiệm thiết yếu'},{phrase:'throw old devices away',meaningVi:'vứt thiết bị cũ'}],B:[{phrase:'face financial difficulties',meaningVi:'gặp khó khăn tài chính'},{phrase:'increase electronic waste',meaningVi:'tăng rác điện tử'}]};
async function setup(t) {
  const db=new PGlite();await db.exec(await readFile(new URL('../db/001-initial.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../db/002-activity-log.sql',import.meta.url),'utf8'));
  let now=1000000;
  const service=createService({store:createStore(db),maxLeases:2,roster:async()=>[{classRef:'c67',className:'Lớp thử 67',students:[{studentRef:'s-a',displayName:'Học viên thử A'},{studentRef:'s-b',displayName:'Học viên thử B'},{studentRef:'s-c',displayName:'Học viên thử C'}]}],secret:'session-fixture-'.padEnd(40,'s'),clock:()=>now});
  const internalSecret='internal-fixture-'.padEnd(40,'i');
  const server=createApi({service,origins:['http://127.0.0.1:8785'],internalSecret});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();});
  const base=`http://127.0.0.1:${server.address().port}/api/handout67/v1`;
  async function call(path,{method='GET',body,token,origin}={}) {
    const response=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{ }),...(origin?{Origin:origin}:{})},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json()};
  }
  const open=async student=>{const r=await call('/sessions',{method:'POST',body:{activity:'lesson5',classRef:'c67',studentRef:student||'s-a'}});assert.equal(r.status,201);return {ref:r.body.session.ref,token:r.body.token,session:r.body.session};};
  const read=async who=>(await call('/sessions/'+who.ref,{token:who.token})).body.session;
  const save=async (who,responses,extra={})=>{const s=await read(who);return call(`/sessions/${who.ref}/responses`,{method:'PUT',token:who.token,body:{baseVersion:s.version,requestId:crypto.randomUUID(),responses,...extra}});};
  const check=async(who,section,extra={})=>{const s=await read(who);return call(`/sessions/${who.ref}/checks`,{method:'POST',token:who.token,body:{section,baseVersion:s.version,requestId:crypto.randomUUID(),...extra}});};
  const claim=async()=>{const r=await call('/internal/jobs/claim',{method:'POST',token:internalSecret,body:{}});assert.equal(r.status,200);return r.body.jobs;};
  const complete=(job,result,extra={})=>call(`/internal/jobs/${job.jobRef}/complete`,{method:'POST',token:internalSecret,body:{...job,result,...extra}});
  async function grade(who,section,result={resultStatus:'passed',feedback:'Nội dung đã phù hợp với yêu cầu bước này.'}) {
    const fields=section==='topic'?['idea1','idea2','topicSentence']:[section];
    assert.equal((await save(who,Object.fromEntries(fields.map(k=>[k,sample[k]])))).status,200);
    assert.equal((await check(who,section)).status,202);
    const jobs=await claim();const job=jobs.find(j=>j.sessionRef===who.ref&&j.section===section);assert.ok(job);
    assert.equal((await complete(job,result)).status,200);
    return job;
  }
  return {db,service,base,call,open,read,save,check,claim,complete,grade,internalSecret,advance:ms=>{now+=ms;}};
}

test('T-HP · đủ Topic, B1/A1/X1 và B2/A2/X2; vocab chỉ mở đúng ý',async t=>{
  const h=await setup(t),who=await h.open();
  for(const step of ['topic','b1','a1','x1'])await h.grade(who,step);
  let s=await h.read(who);assert.equal(s.idea2Open,false);assert.equal(s.vocabulary[1].status,'queued');assert.equal(s.vocabulary[1].groups,undefined);assert.equal(s.vocabulary[2],undefined);
  assert.equal((await h.check(who,'b2')).status,409);
  const [v1]=await h.claim();assert.equal(v1.kind,'vocab');assert.equal(v1.ideaIndex,1);assert.equal((await h.complete(v1,groups)).status,200);
  assert.equal((await h.call(`/sessions/${who.ref}/idea2`,{method:'POST',token:who.token,body:{}})).status,200);
  for(const step of ['b2','a2','x2'])await h.grade(who,step);
  const [v2]=await h.claim();assert.equal(v2.ideaIndex,2);assert.equal((await h.complete(v2,groups)).status,200);
  s=await h.read(who);assert.equal(s.vocabulary[1].status,'ready');assert.equal(s.vocabulary[2].status,'ready');
  assert.ok(Object.values(s.steps).every(step=>step.status==='passed'&&step.history.length===1));
  assert.equal((await h.save(who,{b1:'Đổi điểm đã đạt'})).status,409);
});

test('T-BAD · ô trống, trường lạ và vượt bước bị chặn trước tạo job',async t=>{
  const h=await setup(t),who=await h.open();
  assert.equal((await h.check(who,'topic')).status,400);assert.equal((await h.check(who,'a1')).status,409);
  assert.equal((await h.save(who,{idea1:'   ',evil:'x'})).status,400);
  assert.equal((await h.read(who)).responses.idea1,'');assert.deepEqual(await h.claim(),[]);
});

test('T-CON · hai tab cùng lưu và check trùng; một snapshot, một job, không mất bài',async t=>{
  const h=await setup(t),who=await h.open();
  const first=await h.save(who,{idea1:sample.idea1,idea2:sample.idea2,topicSentence:sample.topicSentence});assert.equal(first.status,200);
  const body={baseVersion:1,requestId:'save-fixed',responses:{idea1:'Nội dung mới'}};
  const saves=await Promise.all([h.call(`/sessions/${who.ref}/responses`,{method:'PUT',token:who.token,body}),h.call(`/sessions/${who.ref}/responses`,{method:'PUT',token:who.token,body:{...body,requestId:'save-other',responses:{idea1:'Không được ghi đè'}}})]);
  assert.deepEqual(saves.map(v=>v.status).sort(),[200,409]);
  const input={baseVersion:2,requestId:'check-fixed'};
  const requests=await Promise.all([h.check(who,'topic',input),h.check(who,'topic',input)]);assert.ok(requests.every(r=>r.status===202));assert.equal(requests[0].body.jobRef,requests[1].body.jobRef);
  const jobs=await h.claim();assert.equal(jobs.length,1);assert.equal(jobs[0].snapshot.responses.idea1,'Nội dung mới');
  assert.equal((await h.check(who,'topic',{...input,baseVersion:1})).status,409);
});

test('T-SEC · token sai người/hết hạn, origin lạ và callback không có quyền bị chặn',async t=>{
  const h=await setup(t),a=await h.open(),b=await h.open('s-b');
  assert.equal((await h.call(`/sessions/${a.ref}`,{token:b.token})).status,401);
  assert.equal((await h.call('/roster',{origin:'https://evil.example'})).status,403);
  assert.equal((await h.call('/internal/jobs/claim',{method:'POST',body:{}})).status,401);
  assert.equal((await h.call('/sessions',{method:'POST',body:{activity:'lesson5',classRef:'c67',studentRef:'outsider'}})).status,403);
  h.advance(43200000);assert.equal((await h.call(`/sessions/${a.ref}`,{token:a.token})).status,401);
});

test('T-PART · callback commit rồi mất ACK; readback và replay không nhân Comment',async t=>{
  const h=await setup(t),who=await h.open();await h.save(who,{idea1:sample.idea1,idea2:sample.idea2,topicSentence:sample.topicSentence});await h.check(who,'topic');const [job]=await h.claim();
  const result={resultStatus:'passed',feedback:'Câu chủ đề bao quát đủ hai ý.'};
  const first=await h.complete(job,result),repeat=await h.complete(job,result);assert.equal(first.status,200);assert.deepEqual(repeat.body,first.body);
  const receipt=await h.call(`/internal/jobs/${job.jobRef}`,{token:h.internalSecret});assert.equal(receipt.body.status,'completed');assert.equal(receipt.body.resultHash,first.body.resultHash);
  assert.equal((await h.read(who)).steps.topic.history.length,1);
  assert.equal((await h.complete(job,{...result,feedback:'Nhận xét khác'})).status,409);
});

test('T-IDENTITY · sai học viên/ý/section/hash/version không ghi kết quả',async t=>{
  const h=await setup(t),who=await h.open(),other=await h.open('s-b');await h.save(who,{idea1:sample.idea1,idea2:sample.idea2,topicSentence:sample.topicSentence});await h.check(who,'topic');const [job]=await h.claim();
  const result={resultStatus:'passed',feedback:'Đã đạt.'};
  for(const extra of [{productId:'writing-flow'},{sessionRef:other.ref},{section:'a1'},{ideaIndex:2},{snapshotHash:'bad'},{promptVersion:'v0'},{operationKey:'other'}])assert.ok([404,409].includes((await h.complete(job,result,extra)).status));
  assert.equal((await h.complete(job,{resultStatus:'passed',feedback:''})).status,422);
  assert.equal((await h.read(who)).steps.topic.status,'pending');assert.equal((await h.read(other)).steps.topic.history.length,0);
});

test('T-TIME · lease đến hạn, cấp lại giữ operationKey và từ chối lease cũ',async t=>{
  const h=await setup(t),who=await h.open();await h.save(who,{idea1:sample.idea1,idea2:sample.idea2,topicSentence:sample.topicSentence});await h.check(who,'topic');const [old]=await h.claim();assert.deepEqual(await h.claim(),[]);
  h.advance(300000);assert.equal((await h.complete(old,{resultStatus:'passed',feedback:'Đạt.'})).status,409);
  const [next]=await h.claim();assert.equal(next.operationKey,old.operationKey);assert.notEqual(next.leaseToken,old.leaseToken);
  assert.equal((await h.complete(old,{resultStatus:'passed',feedback:'Đạt.'})).status,409);
  assert.equal((await h.complete(next,{resultStatus:'passed',feedback:'Đạt.'})).status,200);
});

test('T-ERROR · 3 lỗi kỹ thuật giữ bài, không đếm sai; thử tiếp có lịch sử riêng',async t=>{
  const h=await setup(t),who=await h.open();await h.save(who,{idea1:sample.idea1,idea2:sample.idea2,topicSentence:sample.topicSentence});await h.check(who,'topic');
  for(let i=0;i<3;i++){const [job]=await h.claim();assert.equal((await h.complete(job,undefined,{error:'TECHNICAL_FAILURE'})).status,200);}
  const s=await h.read(who);assert.equal(s.steps.topic.status,'technical_error');assert.equal(s.steps.topic.history.length,0);assert.equal(s.responses.topicSentence,sample.topicSentence);
  assert.deepEqual(await h.claim(),[]);assert.equal((await h.check(who,'topic')).status,202);
});

test('T-HISTORY · cần sửa rồi đạt; lịch sử đúng bước không lẫn A1/A2',async t=>{
  const h=await setup(t),who=await h.open();await h.grade(who,'topic',{resultStatus:'needs_revision',feedback:'Hai ý đã chọn là gì? Hãy làm rõ trong câu chủ đề.'});
  await h.grade(who,'topic');for(const key of ['b1','a1','x1'])await h.grade(who,key);
  const [v]=await h.claim();await h.complete(v,groups);await h.call(`/sessions/${who.ref}/idea2`,{method:'POST',token:who.token,body:{}});await h.grade(who,'b2');
  await h.save(who,{a2:sample.a2});await h.check(who,'a2');const [a2]=await h.claim();assert.deepEqual(a2.snapshot.history,[]);assert.equal(a2.snapshot.responses.b1,sample.b1);
  const s=await h.read(who);assert.equal(s.steps.topic.history.length,2);assert.equal(s.steps.a1.history.length,1);assert.equal(s.steps.a2.history.length,0);
});

test('T-VOCAB · cụm quá 5 từ/sai ý bị chặn; lỗi vocab không khóa ý 2',async t=>{
  const h=await setup(t),who=await h.open();for(const step of ['topic','b1','a1','x1'])await h.grade(who,step);
  const [job]=await h.claim();const invalid=structuredClone(groups);invalid.A[0].phrase='one two three four five six';
  assert.equal((await h.complete(job,invalid)).status,422);assert.equal((await h.complete(job,groups,{ideaIndex:2})).status,409);
  await h.complete(job,undefined,{error:'TECHNICAL_FAILURE'});for(let i=0;i<2;i++){const [j]=await h.claim();await h.complete(j,undefined,{error:'TECHNICAL_FAILURE'});}
  assert.equal((await h.read(who)).vocabulary[1].status,'failed');assert.equal((await h.call(`/sessions/${who.ref}/idea2`,{method:'POST',token:who.token,body:{}})).status,200);
  assert.equal((await h.call(`/sessions/${who.ref}/vocabulary/1/retry`,{method:'POST',token:who.token,body:{}})).status,200);
  const [retry]=await h.claim();assert.equal(retry.kind,'vocab');assert.equal((await h.complete(retry,groups)).status,200);assert.equal((await h.read(who)).steps.x1.history.length,1);
});

test('T-ROLL · khởi động lại service giữ bài/history; phiên mở lại không reset',async t=>{
  const h=await setup(t),who=await h.open();await h.grade(who,'topic');
  const before=await h.read(who),reopened=await h.open();assert.equal(reopened.ref,who.ref);assert.deepEqual(reopened.session,before);
  const fresh=createService({store:createStore(h.db),secret:'session-fixture-'.padEnd(40,'s'),clock:()=>1000000,roster:async()=>[]});
  assert.deepEqual(await fresh.read(who.ref,who.token),before);
});

test('T-ISOLATION · cấu hình không fallback sang backend chung; adapter roster chỉ đọc và lọc scope/PIN',async()=>{
  const env={HANDOUT67_DATABASE_URL:'postgres://handout67_runtime:fake@localhost/handout_writing67',HANDOUT67_SESSION_SECRET:'s'.repeat(40),HANDOUT67_INTERNAL_SECRET:'i'.repeat(40),HANDOUT67_ALLOWED_ORIGINS:'https://tranhoangduc90.github.io',HANDOUT67_ROSTER_URL:'https://roster.example/api/v1/activities/lesson5/roster',HANDOUT67_ALLOWED_CLASSES:'c67',HANDOUT67_PROMPT_FILE:'/run/handout67/prompts.json',HANDOUT67_N8N_WAKE_URL:'https://n8n.example/webhook/fixture',HANDOUT67_N8N_WAKE_SECRET:'w'.repeat(40)};
  assert.equal(config(env).port,3187);assert.throws(()=>config({...env,HANDOUT67_DATABASE_URL:'postgres://writing:fake@localhost/mapping_db'}));assert.throws(()=>config({...env,HANDOUT67_DATABASE_URL:undefined,DATABASE_URL:env.HANDOUT67_DATABASE_URL}));assert.throws(()=>config({...env,HANDOUT67_ALLOWED_ORIGINS:'*'}));
  let calls=0;const get=rosterAdapter(config(env),async(url,options)=>{calls++;assert.equal(options.redirect,'error');assert.equal(options.method,undefined);return {ok:true,json:async()=>({ok:true,classes:[{classRef:'c67',className:'Lớp thử',students:[{studentRef:'a',displayName:'A'},{studentRef:'pin',displayName:'P',requiresAccessCode:true}]},{classRef:'c-other',students:[]}]})};});
  assert.deepEqual(await get(),[{classRef:'c67',className:'Lớp thử',students:[{studentRef:'a',displayName:'A'}]}]);assert.equal(calls,1);
});


test('T-CAPACITY · hai consumer chỉ có tối đa hai lease; job khác chưa được cấp',async t=>{
  const h=await setup(t),a=await h.open(),b=await h.open('s-b'),c=await h.open('s-c');
  for(const who of [a,b,c]) {await h.save(who,{idea1:sample.idea1,idea2:sample.idea2,topicSentence:sample.topicSentence});await h.check(who,'topic');}
  const batches=await Promise.all([h.claim(),h.claim(),h.claim()]);
  assert.deepEqual(batches.map(j=>j.length).sort(),[0,1,1]);
  const jobs=batches.flat();assert.equal(new Set(jobs.map(j=>j.jobRef)).size,2);assert.equal(new Set(jobs.map(j=>j.sessionRef)).size,2);
  await h.complete(jobs.find(j=>j.sessionRef===a.ref),{resultStatus:'passed',feedback:'Đạt.'});
  await h.save(a,{b1:sample.b1});await h.check(a,'b1');
  const [next]=await h.claim();assert.equal(next.sessionRef,c.ref);assert.equal(next.section,'topic');assert.deepEqual(await h.claim(),[]);
});
