import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile,mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve,sep } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { createWake } from '../src/wake.mjs';
import { createStore } from '../src/store.mjs';
import { createService } from '../src/service.mjs';
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

test('T-DURABLE · đóng/mở kho thật trên đĩa không mất phiên/bài',async()=>{
  const base=resolve(process.env.HANDOUT67_TEST_ROOT||tmpdir());
  const folder=await mkdtemp(join(base,'handout67-fixture-'));
  const secret='fixture-session'.padEnd(40,'s');
  const roster=async()=>[{classRef:'c',students:[{studentRef:'s'}]}];
  let db;
  try {
    db=new PGlite(folder);await db.exec(await readFile(new URL('../db/001-initial.sql',import.meta.url),'utf8'));
    const service=createService({store:createStore(db),secret,roster});
    const who=await service.open({activity:'lesson5',classRef:'c',studentRef:'s'});
    const before=await service.save(who.session.ref,who.token,{baseVersion:0,requestId:'fixture-save',responses:{idea1:'Bài phải còn sau restart'}});
    await db.close();db=new PGlite(folder);
    const restarted=createService({store:createStore(db),secret,roster});
    assert.deepEqual(await restarted.read(who.session.ref,who.token),before);
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
    const text=render({kind:'grade',section:'a2',ideaIndex:2,snapshot:{topic:'Đề fixture',responses:{a1:'Câu khác của ý 1',a2:'Câu đúng ý 2',b2:'B đã duyệt ý 2',idea2:'Idea 2',topicSentence:'TS'},history:[{feedback:'Comment đúng A2'}]}});
    assert.ok(text.includes('Câu đúng ý 2'));assert.ok(text.includes('Comment đúng A2'));assert.ok(!text.includes('Câu khác của ý 1'));
    await writeFile(file,'{}');await assert.rejects(()=>promptRenderer(file),/PROMPT_REGISTRY_INVALID/);
  } finally {if(!resolve(folder).startsWith(base+sep))throw new Error('Sai đường fixture');await rm(folder,{recursive:true,force:true});}
});

test('T-PORT · cấu hình không chấp nhận cổng khác Compose/health3187',()=>{
  const env={HANDOUT67_DATABASE_URL:'postgres://handout67_runtime:fake@localhost/handout_writing67',HANDOUT67_SESSION_SECRET:'s'.repeat(40),HANDOUT67_INTERNAL_SECRET:'i'.repeat(40),HANDOUT67_ALLOWED_ORIGINS:'https://fixture.invalid',HANDOUT67_ROSTER_URL:'https://fixture.invalid/roster',HANDOUT67_ALLOWED_CLASSES:'c',HANDOUT67_PROMPT_FILE:'fixture',HANDOUT67_N8N_WAKE_URL:'https://fixture.invalid/wake',HANDOUT67_N8N_WAKE_SECRET:'w'.repeat(40)};
  assert.equal(config(env).port,3187);assert.throws(()=>config({...env,HANDOUT67_PORT:'3188'}));
});
