import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import {setImmediate as turn,setTimeout as delay} from 'node:timers/promises';
import { PGlite } from '@electric-sql/pglite';
import { createWake } from '../src/wake.mjs';
import { createStore } from '../src/store.mjs';
import { createService,TOPIC } from '../src/service.mjs';
import { promptRenderer } from '../src/prompt.mjs';
import { config } from '../src/config.mjs';

test('T-WAKE · mất ACK rồi đánh thức lại; không gửi nội dung và không gửi khi queue rỗng',async t=>{
  let work=true,calls=0,errors=0;
  const wake=createWake({hasWork:async()=>work,url:'https://fixture.invalid/wake',secret:'fixture-wake',intervalMs:100000,fetcher:async(url,args)=>{assert.equal(url,'https://fixture.invalid/wake');assert.deepEqual(JSON.parse(args.body),{productId:'handout-writing67'});assert.equal(args.redirect,'error');calls++;if(calls===1)throw new Error('ACK_LOST');return {ok:true};},onError:()=>errors++});
  t.after(()=>wake.close());
  await wake.tick();await wake.tick();assert.equal(calls,2);assert.equal(errors,1);
  work=false;await wake.tick();assert.equal(calls,2);wake.close();work=true;await wake.tick();assert.equal(calls,2);
});

test('T-WAKE-CON · hai tick cùng lúc chỉ gửi một tín hiệu',async t=>{
  let calls=0;let release;
  const pending=new Promise(resolve=>{release=resolve;});
  const wake=createWake({hasWork:async()=>true,url:'https://fixture.invalid/wake',secret:'fixture',intervalMs:100000,fetcher:async()=>{calls++;await pending;return {ok:true};}});t.after(()=>wake.close());
  const a=wake.tick();await new Promise(resolve=>setImmediate(resolve));const b=wake.tick();release();await Promise.all([a,b]);assert.equal(calls,1);
});

test('T-WAKE-BURST · đánh thức mỗi job chờ, không dồn cả lớp vào một execution',async t=>{
  let work=['a:0','b:0','c:0'],calls=0;
  const wake=createWake({hasWork:async()=>work,url:'https://fixture.invalid/wake',secret:'fixture',intervalMs:100000,fetcher:async()=>{calls++;return {ok:true};}});t.after(()=>wake.close());
  await wake.tick();assert.equal(calls,3);await wake.tick();assert.equal(calls,3);
  work=['a:1','d:0'];await wake.tick();assert.equal(calls,5);
  work=[];await wake.tick();assert.equal(calls,5);
});

test('T-WAKE-PULSE · gộp tín hiệu, vẫn đọc lượt mới đến khi đang đánh thức',async t=>{
  let work=['a:0'],scans=0,calls=0,releaseFirst,observeFirst,observeSecond;
  const first=new Promise(resolve=>{observeFirst=resolve;});
  const second=new Promise(resolve=>{observeSecond=resolve;});
  const paused=new Promise(resolve=>{releaseFirst=resolve;});
  const wake=createWake({hasWork:async()=>{scans++;return work;},url:'https://fixture.invalid/wake',
    secret:'fixture',intervalMs:100000,fetcher:async()=>{
      calls++;
      if(calls===1){observeFirst();await paused;}else observeSecond();
      return {ok:true};
    }});
  t.after(()=>{releaseFirst();wake.close();});
  wake.request();wake.request();await first;
  work=['a:0','b:0'];wake.request();wake.request();
  releaseFirst();await second;
  assert.equal(scans,2);assert.equal(calls,2);
  await turn();
  wake.request();wake.close();await turn();
  assert.equal(scans,2);
});

test('T-WAKE-LIMIT · chỉ gửi tối đa số webhook đồng thời được đặt',async t=>{
  let active=0,peak=0,calls=0;
  const wake=createWake({hasWork:async()=>['a:0','b:0','c:0','d:0','e:0'],
    url:'https://fixture.invalid/wake',secret:'fixture',intervalMs:100000,maxDispatches:2,fetcher:async()=>{
      calls++;active++;peak=Math.max(peak,active);
      await turn();
      active--;return {ok:true};
    }});
  t.after(()=>wake.close());
  await wake.tick();
  assert.equal(calls,5);assert.equal(peak,2);
});

test('T-WAKE-FALLBACK · bộ dò mới đọc hàng bền khi tín hiệu không tới',async t=>{
  let calls=0;
  const wake=createWake({hasWork:async()=>['persisted:0'],url:'https://fixture.invalid/wake',
    secret:'fixture',intervalMs:10,fetcher:async()=>{calls++;return {ok:true};}});
  t.after(()=>wake.close());
  for(let i=0;i<10&&!calls;i++)await delay(10);
  assert.equal(calls,1);
});

test('T-DURABLE · restart giữ bản bài và nhận lại lượt chấm đã ghi dù mất tín hiệu',async()=>{
  const base=resolve(process.env.HANDOUT67_TEST_ROOT||tmpdir());
  const folder=await mkdtemp(join(base,'handout67-fixture-'));
  const secret='fixture-session'.padEnd(40,'s');
  const roster=async()=>[{classRef:'c',students:[{studentRef:'s'}]}];
  let db;
  try {
    db=new PGlite(folder);await db.exec(await readFile(new URL('../db/001-initial.sql',import.meta.url),'utf8'));
    await db.exec(await readFile(new URL('../db/002-activity-log.sql',import.meta.url),'utf8'));
    const renderJob=()=> 'Rubric fixture tiếng Việt.';
    const service=createService({store:createStore(db),secret,roster,renderJob});
    const who=await service.open({activity:'lesson5',classRef:'c',studentRef:'s'});
    await service.save(who.session.ref,who.token,{baseVersion:0,requestId:'fixture-save',responses:{
      idea1:'Bài phải còn sau restart',idea2:'Luận điểm thứ hai',topicSentence:'A sample topic sentence.',
    }});
    const before=await service.check(who.session.ref,who.token,{baseVersion:1,requestId:'fixture-check',section:'topic'});
    await db.close();db=new PGlite(folder);
    const store=createStore(db),restarted=createService({store,secret,roster,renderJob});
    assert.deepEqual(await restarted.read(who.session.ref,who.token),before.session);
    let calls=0;
    const wake=createWake({hasWork:async()=>{
      const job=await store.findJob(before.jobRef,who.session.ref);
      return job?.status==='queued'?[job.jobRef+':'+job.tries]:[];
    },url:'https://fixture.invalid/wake',secret:'fixture',fetcher:async()=>{
      calls++;
      const [job]=await restarted.claim();
      assert.equal(job.jobRef,before.jobRef);
      await restarted.complete({...job,result:{resultStatus:'passed',feedback:'Đã chấm fixture.'}});
      return {ok:true};
    }});
    try {
      await wake.tick();await wake.tick();
      assert.equal(calls,1);
      const after=await restarted.read(who.session.ref,who.token);
      assert.equal(after.responses.idea1,'Bài phải còn sau restart');
      assert.equal(after.steps.topic.history.length,1);
      assert.equal(after.steps.topic.status,'passed');
    } finally {wake.close();}
  } finally {
    if(db)await db.close();
    if(!resolve(folder).startsWith(base+sep))throw new Error('Không xóa fixture ngoài thư mục thử');
    await rm(folder,{recursive:true,force:true});
  }
});

test('T-PROMPT · rubric riêng ngoài public image; payload đúng A2 và history, không mượn A1',async()=>{
  const base=resolve(process.env.HANDOUT67_TEST_ROOT||tmpdir());const folder=await mkdtemp(join(base,'handout67-prompt-'));
  const {writeFile}=await import('node:fs/promises');
  try {
    const file=join(folder,'fixture.json');
    await writeFile(file,JSON.stringify({version:'lesson5-rubric-v3',rubrics:Object.fromEntries(['topic','b1','b2','a','x','vocab'].map(k=>[k,'Rubric fixture '+k]))}));
    const render=await promptRenderer(file);
    const text=render({kind:'grade',section:'a2',ideaIndex:2,promptVersion:'lesson5-rubric-v3',snapshot:{topic:TOPIC,responses:{a1:'Câu khác của ý 1',a2:'Câu đúng ý 2',b2:'B đã duyệt ý 2',idea2:'Idea 2',topicSentence:'TS'},history:[{feedback:'Comment đúng A2'}]}});
    assert.ok(text.includes('Câu đúng ý 2'));assert.ok(text.includes('Comment đúng A2'));assert.ok(!text.includes('Câu khác của ý 1'));
    await writeFile(file,'{}');await assert.rejects(()=>promptRenderer(file),/PROMPT_REGISTRY_INVALID/);
  } finally {if(!resolve(folder).startsWith(base+sep))throw new Error('Sai đường fixture');await rm(folder,{recursive:true,force:true});}
});

test('T-PORT · cấu hình không chấp nhận cổng khác Compose/health3187',()=>{
  const env={HANDOUT67_DATABASE_URL:'postgres://handout67_runtime:fake@localhost/handout_writing67',HANDOUT67_SESSION_SECRET:'s'.repeat(40),HANDOUT67_INTERNAL_SECRET:'i'.repeat(40),HANDOUT67_ALLOWED_ORIGINS:'https://fixture.invalid',HANDOUT67_ROSTER_URL:'https://fixture.invalid/roster',HANDOUT67_ALLOWED_CLASSES:'c',HANDOUT67_PROMPT_FILE:'fixture',HANDOUT67_N8N_WAKE_URL:'https://fixture.invalid/wake',HANDOUT67_N8N_WAKE_SECRET:'w'.repeat(40)};
  assert.equal(config(env).port,3187);assert.throws(()=>config({...env,HANDOUT67_PORT:'3188'}));
});
