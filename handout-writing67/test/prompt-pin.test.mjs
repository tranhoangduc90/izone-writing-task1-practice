// Kiểm prompt của cùng một job không đổi qua retry/redeploy; không gọi AI thật.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createStore} from '../src/store.mjs';
const {createService}=await import(process.env.HANDOUT67_PIN_SERVICE||new URL('../src/service.mjs',import.meta.url).href);
async function fixture(t){
 const db=new PGlite();await db.exec(await readFile(new URL('../db/001-initial.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 await db.exec(await readFile(new URL('../db/002-activity-log.sql',import.meta.url),'utf8'));
 let now=1000000;
 const settings={store:createStore(db),secret:'fixture-secret'.padEnd(40,'s'),roster:async()=>[{classRef:'c',students:[{studentRef:'s'}]}],clock:()=>now};
 const service=createService({...settings,promptVersion:'lesson5-rubric-v3',renderJob:()=> 'Original private prompt'});
 const who=await service.open({activity:'lesson5',classRef:'c',studentRef:'s'});
 await service.save(who.session.ref,who.token,{baseVersion:0,requestId:'save',responses:{idea1:'Idea one',idea2:'Idea two',topicSentence:'Topic'}});
 return {settings,service,who,advance:()=>{now+=300000;}};
}
test('T-PROMPT-PIN · retry sau redeploy giữ prompt và operationKey cũ',async t=>{
 const h=await fixture(t);await h.service.check(h.who.session.ref,h.who.token,{section:'topic',baseVersion:1,requestId:'check'});
 const [first]=await h.service.claim();h.advance();
 const nextService=createService({...h.settings,promptVersion:'lesson5-rubric-v4',renderJob:()=> 'Changed private prompt'});
 const [next]=await nextService.claim();assert.equal(next.prompt,first.prompt);assert.equal(next.operationKey,first.operationKey);assert.notEqual(next.leaseToken,first.leaseToken);
 await nextService.complete({...next,result:{resultStatus:'passed',feedback:'Nhận xét giả để kiểm ghim prompt.'}});
 await nextService.save(h.who.session.ref,h.who.token,{baseVersion:1,requestId:'save-b',responses:{b1:'B'}});
 await nextService.check(h.who.session.ref,h.who.token,{section:'b1',baseVersion:2,requestId:'check-b'});
 const [fresh]=await nextService.claim();assert.equal(fresh.promptVersion,'lesson5-rubric-v4');assert.equal(fresh.prompt,'Changed private prompt');
});
test('T-PROMPT-LEGACY · job cũ chưa ghim prompt không đổi payload dưới operationKey cũ',async t=>{
 const h=await fixture(t);const old=createService({...h.settings,promptVersion:'lesson5-rubric-v2'});
 await old.check(h.who.session.ref,h.who.token,{section:'topic',baseVersion:1,requestId:'old-check'});
 const next=createService({...h.settings,promptVersion:'lesson5-rubric-v3',renderJob:()=> 'New prompt'});
 assert.deepEqual(await next.claim(),[]);
 const s=await next.read(h.who.session.ref,h.who.token);assert.equal(s.steps.topic.status,'technical_error');assert.equal(s.steps.topic.history.length,0);assert.equal(s.responses.topicSentence,'Topic');
});
