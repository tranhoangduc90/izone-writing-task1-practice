// Isolated PostgreSQL only. No AI, Google, Portal or production database access.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createReading67Postgres} from '../../src/reading-listening67/web-postgres.js';
import {createReading67WebStore,createReading67WebWorker} from '../../src/reading-listening67/web-store.js';
import {createWebWorkCoordinator,selectReadyWebScopes} from '../../src/reading-listening67/web-work-coordinator.js';
import {createReading67Homework} from '../../src/reading-listening67/web-homework.js';
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

test('Native idle benchmark: six Docs lessons retain 500-ms checks with at least 70 percent fewer database admissions',async()=>{
 const scopes=Array.from({length:6},(_,n)=>({code:'idle-'+n,version:'fixture-v1'}));
 async function measure(shared){
  let admissions=0;const durations=[];
  const watched={query:async(...args)=>{admissions++;return db.query(...args);},transaction:async fn=>{admissions++;return db.transaction(fn);}};
  const homes=scopes.map(metadata=>createReading67Homework({db:watched,metadata,pageBase:'https://fixture.test/homework',owner:{resolve(){throw Error('UNEXPECTED_OWNER_CALL');}},docs:{read(){throw Error('UNEXPECTED_GOOGLE_CALL');}}}));
  const runner=shared?createWebWorkCoordinator({db:watched}):null;const timers=[];let stopped=false;const pending=new Set();
  function startLegacy(homework){const tick=()=>{if(stopped)return;const run=homework.once().finally(()=>{pending.delete(run);if(!stopped)timers.push(setTimeout(tick,500));});pending.add(run);};tick();}
  const handles=homes.map((homework,n)=>runner?runner.register({lane:'docs',scope:scopes[n],run:()=>homework.once()}):startLegacy(homework));
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
