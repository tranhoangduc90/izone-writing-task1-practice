// Isolated PostgreSQL only. No AI, Google, Portal or production database access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {createReading67Postgres} from '../../src/reading-listening67/web-postgres.js';
import {createReading67WebStore,createReading67WebWorker} from '../../src/reading-listening67/web-store.js';
import {createWebWorkCoordinator,selectReadyWebScopes} from '../../src/reading-listening67/web-work-coordinator.js';
import {createReading67Homework} from '../../src/reading-listening67/web-homework.js';
import {claimWebWorkBatch,releaseUnstartedWebWork} from '../../src/reading-listening67/web-work-claims.js';
import {createReading67WebRouter} from '../../src/reading-listening67/web-routes.js';
const connectionString=process.env.TEST_SERVICES_DATABASE_URL;
if(!connectionString||new URL(connectionString).pathname!=='/test_services_optimization_20261101')throw Error('ISOLATED_FIXTURE_DATABASE_REQUIRED');
const db=createReading67Postgres({connectionString,max:4});
assert.equal((await db.query('SELECT current_database() AS name')).rows[0].name,'test_services_optimization_20261101');
await db.query(await fs.readFile(new URL('../listening-homework67/schema.sql',import.meta.url),'utf8'));
const scope=(code,owner=randomUUID())=>({ownerId:owner,courseId:'fixture-class',code,version:'fixture-v1'});
const grader={pins:{sha256:'fixture-pin'},profile:{expected_target_ids:['answer']},inspectWeb(answers){return {parsed:{targets:Object.entries(answers).map(([target_id,source_text])=>({target_id,source_text}))},completeness:{eligible_for_grading:true}};}};
const body=tag=>({answers:{answer:tag},notes:'fixture notes',flags:[],annotations:[]});
const result=job=>({pins:grader.pins,context:{operationId:job.jobId,sourceDigest:job.inputHash},grading:{target_results:[{target_id:'answer',verdict:'correct'}]}});
const save=(store,s,tag,baseRevision=0,mutationId=randomUUID())=>store.save(s,{baseRevision,mutationId,body:body(tag)});
const submit=(store,s,revision=1,requestId=randomUUID())=>store.submit(s,{revision,requestId});
async function until(predicate,timeout=5000){const end=Date.now()+timeout;while(Date.now()<end){if(await predicate())return;await new Promise(r=>setTimeout(r,10));}throw Error('FIXTURE_WAIT_TIMEOUT');}
test.after(()=>db.close());

test('Commit callbacks run after durable commit; rollback and lost wake cannot invalidate a saved draft',async()=>{
 const s=scope('commit');let observed;
 await db.transaction(async tx=>{await tx.query('INSERT INTO reading_listening67.web_draft(owner_id,course_id,assignment_code,content_version) VALUES($1,$2,$3,$4)',[s.ownerId,s.courseId,s.code,s.version]);tx.afterCommit(()=>{observed=true;throw Error('LOST_WAKE');});});
 assert.equal(observed,true);assert.equal((await db.query('SELECT count(*)::int n FROM reading_listening67.web_draft WHERE assignment_code=$1',[s.code])).rows[0].n,1);
 let rolledBack=false;
 await assert.rejects(db.transaction(async tx=>{tx.afterCommit(()=>{rolledBack=true;});throw Error('ROLLBACK_FIXTURE');}),/ROLLBACK_FIXTURE/);assert.equal(rolledBack,false);
});

test('Concurrent native mutation retry keeps one revision and immutable submitted snapshot',async()=>{
 const s=scope('replay'),store=createReading67WebStore({db,grader,jobScope:s}),id=randomUUID();
 const a=await Promise.all([save(store,s,'old',0,id),save(store,s,'old',0,id)]);assert.equal(a[0].revision,1);assert.equal(a[1].revision,1);
 const request=randomUUID(),sent=await Promise.all([submit(store,s,1,request),submit(store,s,1,request)]);assert.equal(sent[0].attemptId,sent[1].attemptId);
 await save(store,s,'new',1);assert.equal((await store.attempt(s,sent[0].attemptId)).snapshot.answers.answer,'old');assert.equal((await store.draft(s)).body.answers.answer,'new');
});

test('Grouped readiness plus concurrent scoped claims preserves native locks, lease and identity',async()=>{
 const a=scope('claim-A'),b=scope('claim-B'),storeA=createReading67WebStore({db,grader,jobScope:a}),storeB=createReading67WebStore({db,grader,jobScope:b});
 await save(storeA,a,'A');await save(storeB,b,'B');await submit(storeA,a);await submit(storeB,b);
 const ready=await selectReadyWebScopes(db,'grading',[a,b]);assert.deepEqual(new Set(ready.map(r=>r.code)),new Set([a.code,b.code]));
 const claims=await Promise.all([storeA.claim(),storeA.claim(),storeB.claim()]);assert.equal(claims.filter(Boolean).length,2);
 const ja=claims.slice(0,2).find(Boolean),jb=claims[2];assert.equal(ja.answers.answer,'A');assert.equal(jb.answers.answer,'B');
 await assert.rejects(storeA.finish({...ja,ownerId:b.ownerId},result(ja)),{code:'JOB_LEASE_NOT_OWNED'});
 await storeB.finish(jb,result(jb));await storeA.finish(ja,result(ja));assert.equal((await storeA.history(a))[0].status,'done');assert.equal((await storeB.history(b))[0].status,'done');
});

test('Shared workers process independent lesson scopes while one grader is blocked, without losing saved history',async()=>{
 const a=scope('runner-A'),b=scope('runner-B');db.workCoordinator=createWebWorkCoordinator({db});
 const sa=createReading67WebStore({db,grader,jobScope:a}),sb=createReading67WebStore({db,grader,jobScope:b});let release,started=false;
 const pending=new Promise(r=>release=r);
 const makeGrader=slow=>({...grader,prepareWeb:(_answers,jobId)=>({jobId}),async finish({jobId}){if(slow){started=true;await pending;}const row=(await db.query('SELECT j.*,a.* FROM reading_listening67.web_job j JOIN reading_listening67.web_attempt a ON a.id=j.attempt_id WHERE j.id=$1',[jobId])).rows[0];return result({jobId,inputHash:row.input_hash});}});
 const errors=[],wa=createReading67WebWorker({store:sa,grader:makeGrader(true),onError:e=>errors.push(e)}),wb=createReading67WebWorker({store:sb,grader:makeGrader(false),onError:e=>errors.push(e)});
 try{
  wa.start();wb.start();await save(sa,a,'A');await save(sb,b,'B');const aa=await submit(sa,a),bb=await submit(sb,b);
  await until(()=>started);await until(async()=> (await sb.attempt(b,bb.attemptId)).status==='done');
  assert.equal((await sa.attempt(a,aa.attemptId)).status,'processing');await save(sa,a,'A edited',1);release();
  await until(async()=> (await sa.attempt(a,aa.attemptId)).status==='done');assert.equal((await sa.draft(a)).body.answers.answer,'A edited');assert.equal(errors.length,0);
 }finally{release();await wa.close();await wb.close();await db.workCoordinator.close();delete db.workCoordinator;}
});

test('Native batch claims skip locked jobs and concurrent instances cannot receive the same lease',async()=>{
 const a=scope('batch-A'),b=scope('batch-B'),sa=createReading67WebStore({db,grader,jobScope:a}),sb=createReading67WebStore({db,grader,jobScope:b});
 const sent=[];
 for(let n=0;n<4;n++){const s={...a,ownerId:randomUUID()};await save(sa,s,'A-'+n);sent.push(await submit(sa,s));}
 await save(sb,b,'B');const bb=await submit(sb,b);let release,locked=false;
 const wait=new Promise(resolve=>release=resolve);
 const blocking=db.transaction(async tx=>{await tx.query('SELECT id FROM reading_listening67.web_job WHERE id=$1 FOR UPDATE',[sent[0].jobId]);locked=true;await wait;});
 try{
  await until(()=>locked);
  const sets=await Promise.all([claimWebWorkBatch(db,'grading',[a,b]),claimWebWorkBatch(db,'grading',[a,b])]),items=sets.flat();
  assert.equal(items.length,3);assert.equal(new Set(items.map(i=>i.job.jobId)).size,3);assert.equal(new Set(items.map(i=>i.job.leaseToken)).size,3);
  assert.ok(items.every(i=>i.job.jobId!==sent[0].jobId));assert.equal(items.filter(i=>i.job.jobId===bb.jobId).length,1);
  for(const item of items){assert.equal(item.job.ownerId,item.code===b.code?b.ownerId:(await db.query('SELECT owner_id FROM reading_listening67.web_attempt WHERE id=$1',[item.job.attemptId])).rows[0].owner_id);await (item.code===b.code?sb:sa).finish(item.job,result(item.job));}
 }finally{release();await blocking;}
 const resumed=await claimWebWorkBatch(db,'grading',[a]);assert.equal(resumed.length,1);await releaseUnstartedWebWork(db,'grading',resumed);
 assert.equal((await db.query('SELECT status FROM reading_listening67.web_job WHERE id=$1',[resumed[0].job.jobId])).rows[0].status,'queued');
});

test('Native Docs batch preserves owner, document, sequence and verifies each accepted job through the existing writer',async()=>{
 const a=scope('docs-batch-A'),b=scope('docs-batch-B'),writes=[],values=new Map();
 const homes=[a,b].map(metadata=>createReading67Homework({db,metadata,pageBase:'https://fixture.test/homework',
  owner:{async resolve(s){return {classId:s.courseId,studentRef:s.ownerId,code:s.code,version:s.version,documentId:'fixture-doc-'+s.ownerId,tabId:'fixture-tab'};}},
  docs:{async read(id){return {value:values.get(id)};},async write(id,plan){writes.push({id,value:plan.value});values.set(id,plan.value);}},
  planWrite(document,binding,job){const value=JSON.stringify([binding.document_id,job.binding_id,job.sequence,job.payload]);return {verified:document.value===value,value};}
 }));
 const stores=[a,b].map((metadata,n)=>createReading67WebStore({db,grader,jobScope:metadata,homework:homes[n]}));
 await save(stores[0],a,'A');await save(stores[1],b,'B');
 for(let sequence=0;sequence<=1;sequence++){
  const claims=await claimWebWorkBatch(db,'docs',[a,b]);assert.equal(claims.length,2);
  await Promise.all(claims.reverse().map(async item=>{assert.equal(item.job.sequence,sequence);const index=item.code===a.code?0:1;assert.equal(await homes[index].once(item.job),true);}));
 }
 assert.equal(writes.length,4);assert.equal(new Set(writes.map(w=>w.id)).size,2);
 for(let n=0;n<2;n++){const status=await homes[n].status([a,b][n]);assert.equal(status.cta,'verified');assert.equal(status.status,'verified');assert.ok(status.jobs.every(j=>j.status==='verified'));}
});

test('Two native service instances notify only after commit, keep native claims and recover from a lost listener',async()=>{
 const errors=[],writer=createReading67Postgres({connectionString,max:2,workCoordinatorEnabled:true,onWorkSignalError:e=>errors.push(e.code)}),reader=createReading67Postgres({connectionString,max:2,workCoordinatorEnabled:true,onWorkSignalError:e=>errors.push(e.code)});
 const s=scope('notify-native'),store=createReading67WebStore({db:writer,grader,jobScope:s}),received=[];
 const handle=reader.workCoordinator.register({lane:'grading',scope:s,batchClaim:true,async run(job){received.push(job);await store.finish(job,result(job));return true;}});
 try{
  await until(()=>writer.workSignals.snapshot().connected&&reader.workSignals.snapshot().connected);
  const before=reader.workSignals.snapshot().received;
  await assert.rejects(writer.transaction(async tx=>{tx.afterCommit(()=>writer.wakeWork('grading'));throw Error('ROLLBACK_NOTIFICATION');}),/ROLLBACK_NOTIFICATION/);
  await new Promise(resolve=>setTimeout(resolve,30));assert.equal(reader.workSignals.snapshot().received,before);
  await save(store,s,'first');const first=await submit(store,s);
  await until(()=>reader.workSignals.snapshot().received>before);await until(async()=> (await store.attempt(s,first.attemptId)).status==='done');assert.equal(received[0].ownerId,s.ownerId);
  const connections=reader.workSignals.snapshot().connections;
  // Strong DB guard at the top restricts this fault injection to our isolated fixture.
  await db.query("SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND application_name='reading67_work_listener' AND pid<>pg_backend_pid()");
  await until(()=>reader.workSignals.snapshot().connected&&reader.workSignals.snapshot().connections>connections);
  await save(store,s,'second',1);const second=await submit(store,s,2);await until(async()=> (await store.attempt(s,second.attemptId)).status==='done');
  assert.equal(received.length,2);assert.notEqual(received[0].jobId,received[1].jobId);assert.ok(errors.length>=1);
 }finally{await handle.close();await writer.close();await reader.close();}
});

test('A post-commit wake failure preserves the save and submission and a peer finds durable work by fallback',async()=>{
 const writer=createReading67Postgres({connectionString,max:2,workCoordinatorEnabled:true}),reader=createReading67Postgres({connectionString,max:2,workCoordinatorEnabled:true});
 const s=scope('notify-lost'),store=createReading67WebStore({db:writer,grader,jobScope:s});
 const handle=reader.workCoordinator.register({lane:'grading',scope:s,batchClaim:true,async run(job){await store.finish(job,result(job));return true;}});
 try{
  await until(()=>reader.workSignals.snapshot().connected);
  writer.wakeWork=()=>{throw Error('WAKE_DELIVERY_LOST');};
  const saved=await save(store,s,'durable');assert.equal(saved.revision,1);
  const sent=await submit(store,s);await until(async()=> (await store.attempt(s,sent.attemptId)).status==='done');
  assert.equal((await store.draft(s)).body.answers.answer,'durable');assert.equal((await store.history(s)).length,1);
 }finally{await handle.close();await writer.close();await reader.close();}
});

test('Native HTTP handoff keeps legacy and compact clients compatible across two service instances',async()=>{
 const previous=createReading67Postgres({connectionString,max:2}),candidate=createReading67Postgres({connectionString,max:2,workCoordinatorEnabled:true});
 const s=scope('http-handoff'),other={...s,ownerId:randomUUID()},oldStore=createReading67WebStore({db:previous,grader,jobScope:s}),newStore=createReading67WebStore({db:candidate,grader,jobScope:s});
 const servers=[];
 async function endpoint(store){
  const app=express();app.use('/api',createReading67WebRouter({store,content:{code:s.code,version:s.version},grader,authenticate:q=>q.headers.authorization==='Bearer fixture-A'?s:q.headers.authorization==='Bearer fixture-B'?other:null}));
  const server=app.listen(0,'127.0.0.1');servers.push(server);await new Promise(resolve=>server.once('listening',resolve));
  return 'http://127.0.0.1:'+server.address().port+'/api';
 }
 async function call(base,path,{method='GET',value,owner='A',status=200}={}){
  const response=await fetch(base+path,{method,headers:{'Content-Type':'application/json',Authorization:'Bearer fixture-'+owner},...(value?{body:JSON.stringify(value)}:{})});
  const data=await response.json();assert.equal(response.status,status,JSON.stringify(data));return data;
 }
 let worker;
 try{
  const oldUrl=await endpoint(oldStore),newUrl=await endpoint(newStore);
  const first={baseRevision:0,mutationId:randomUUID(),body:body('legacy value')};
  const oldAck=await call(oldUrl,'/draft',{method:'PUT',value:first});assert.equal(oldAck.revision,1);assert.deepEqual(oldAck.body,first.body);
  const second={baseRevision:1,mutationId:randomUUID(),body:{...body('candidate value'),notes:'Giữ nguyên qua chuyển bản và thử lại. '.repeat(250)}};
  const compact=await call(newUrl,'/draft?ack=compact-v1',{method:'PUT',value:second});assert.equal(compact.revision,2);assert.equal(compact.body,undefined);
  // Retry the same mutation on the other instance, as after a lost response or routing change.
  const retry=await call(oldUrl,'/draft',{method:'PUT',value:second});assert.equal(retry.revision,2);assert.deepEqual(retry.body,second.body);assert.equal(retry.savedAt,compact.savedAt);
  const requestId=randomUUID(),sent=await call(oldUrl,'/submit',{method:'POST',value:{revision:2,requestId},status:202});
  const again=await call(newUrl,'/submit',{method:'POST',value:{revision:2,requestId},status:202});assert.equal(again.attemptId,sent.attemptId);
  await call(newUrl,'/attempts/'+sent.attemptId,{owner:'B',status:404});await call(newUrl,'/draft',{owner:'unknown',status:401});
  const grading={...grader,prepareWeb:(_answers,jobId)=>({jobId}),async finish({jobId}){const row=(await candidate.query('SELECT a.input_hash FROM reading_listening67.web_job j JOIN reading_listening67.web_attempt a ON a.id=j.attempt_id WHERE j.id=$1',[jobId])).rows[0];return result({jobId,inputHash:row.input_hash});}};
  worker=createReading67WebWorker({store:newStore,grader:grading});worker.start();
  await until(async()=> (await call(oldUrl,'/attempts/'+sent.attemptId)).status==='done');
  const next={baseRevision:2,mutationId:randomUUID(),body:body('new draft after submit')};
  const parallel=await Promise.all([call(oldUrl,'/draft',{method:'PUT',value:next}),call(newUrl,'/draft?ack=compact-v1',{method:'PUT',value:next})]);assert.ok(parallel.every(r=>r.revision===3));
  const saved=await call(newUrl,'/draft');assert.deepEqual(saved.body,next.body);assert.equal(saved.revision,3);
  const historical=await call(newUrl,'/attempts/'+sent.attemptId);assert.deepEqual(historical.snapshot,second.body);assert.equal((await call(oldUrl,'/attempts')).attempts.length,1);
 }finally{
  await worker?.close();await Promise.all(servers.map(server=>new Promise(resolve=>server.close(resolve))));await previous.close();await candidate.close();
 }
});

test('Native idle benchmark: six Docs lessons retain 500-ms checks with at least 70 percent fewer database admissions',async()=>{
 const scopes=Array.from({length:6},(_,n)=>({code:'idle-'+n,version:'fixture-v1'}));
 async function measure(shared){
  let admissions=0;const durations=[];
  const watched={query:async(...args)=>{admissions++;return db.query(...args);},transaction:async fn=>{admissions++;return db.transaction(fn);}};
  const homes=scopes.map(metadata=>createReading67Homework({db:watched,metadata,pageBase:'https://fixture.test/homework',owner:{resolve(){throw Error('UNEXPECTED_OWNER_CALL');}},docs:{read(){throw Error('UNEXPECTED_GOOGLE_CALL');}}}));
  const runner=shared?createWebWorkCoordinator({db:watched}):null;const timers=[];let stopped=false;const pending=new Set();
  function startLegacy(homework){const tick=()=>{if(stopped)return;const run=homework.once().finally(()=>{pending.delete(run);if(!stopped)timers.push(setTimeout(tick,500));});pending.add(run);};tick();}
  const handles=homes.map((homework,n)=>runner?runner.register({lane:'docs',scope:scopes[n],batchClaim:true,run:job=>homework.once(job)}):startLegacy(homework));
  // Concurrent real writes/ACKs exercise the same pool while idle lanes poll.
  const store=createReading67WebStore({db,grader}),s=scope('latency-'+shared);let revision=0;
  const started=performance.now();
  while(performance.now()-started<2100){const at=performance.now();await save(store,s,'value-'+revision,revision);durations.push(performance.now()-at);revision++;await new Promise(r=>setTimeout(r,100));}
  stopped=true;for(const timer of timers)clearTimeout(timer);await Promise.all([...pending]);
  if(runner){for(const h of handles)await h.close();await runner.close();}
  durations.sort((a,b)=>a-b);return {admissions,writes:revision,p95_ms:durations[Math.min(durations.length-1,Math.ceil(durations.length*.95)-1)]};
 }
 const legacy=await measure(false),shared=await measure(true),reduction=1-shared.admissions/legacy.admissions;
 console.log('IDLE_BENCHMARK '+JSON.stringify({legacy,shared,reduction}));
 assert.ok(reduction>=.7,JSON.stringify({legacy,shared,reduction}));assert.ok(shared.writes>=10);assert.ok(legacy.writes>=10);
 // Latency is recorded, not certified by an arbitrary tiny fixture threshold.
});
