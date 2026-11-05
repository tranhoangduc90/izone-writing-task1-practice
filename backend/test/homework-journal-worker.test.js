import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {PGlite} from '@electric-sql/pglite';
import request from 'supertest';
import {createListeningHomeworkApp} from '../src/listening-homework67/app.js';
import {createHomeworkWorkerJournal} from '../src/reading-listening67/web-journal-worker.js';

const ownerA='11111111-1111-4111-8111-111111111111',ownerB='22222222-2222-4222-8222-222222222222';
const prefix='/api/listening-homework67';
const lesson=code=>({code,version:'fixture-v1',title:'Fixture',homeworkLesson:2,minimumCompletion:.8,audioId:'fixture-audio',groups:[],questions:[],
 items:['U1','U2','U3'].map(id=>({id,group:'fixture',question:'Fixture',answer:'approved '+id,core:'Meaning '+id,accept:'Valid variants',reject:'Contradictions',units:[{id:id+'.u1',meaning:'first'},{id:id+'.u2',meaning:'second'}]}))});
async function setup(t,{stalled=false}={}){
 const db=new PGlite();await db.exec(await readFile(new URL('../ops/listening-homework67/schema.sql',import.meta.url),'utf8'));
 t.after(()=>db.close());const calls=[],scopes=[];
 const journal={observe:s=>s,context(scope,runNo){scopes.push({...scope,runNo});return{ownerId:scope.ownerId,courseId:scope.courseId,runNo,bindingId:'fixture'};},
  worker(scope,receipt){calls.push({scope,receipt});return stalled?new Promise(()=>{}):{ok:true,persisted:true};}};
 const identity={authenticate:async q=>({ownerId:q.headers.authorization==='Bearer fixture-b'?ownerB:ownerA,courseId:'fixture-class'})};
 const runtime=createListeningHomeworkApp({db,lesson:lesson('67-listening-fixture'),identity,journal,origins:[],studentsOpen:true,
  provider:async()=>{throw Error('No AI expected for approved fixture answers');}});
 t.after(()=>runtime.worker.close());
 return{db,runtime,calls,scopes,journal};
}
const body={answers:{U1:'approved U1',U2:'approved U2',U3:'approved U3'},annotations:[],notes:'PRIVATE-NOTES-CANARY',flags:[]};
const scope=ownerId=>({ownerId,courseId:'fixture-class',code:'67-listening-fixture',version:'fixture-v1'});
async function submit(f,ownerId){
 const saved=await f.runtime.store.save(scope(ownerId),{baseRevision:0,mutationId:randomUUID(),body});
 return f.runtime.store.submit(scope(ownerId),{revision:saved.revision,requestId:randomUUID()});
}

test('worker logs follow immutable attempt owner/run through two jobs and a reset, including prefetched native jobs',async t=>{
 const f=await setup(t),a=await submit(f,ownerA),b=await submit(f,ownerB);
 await f.runtime.store.reset(scope(ownerA),{baseRevision:1,mutationId:randomUUID()});
 // The live worker accepts the coordinator's preclaimed job. Canonical still
 // claims inside tick; exercise each actual API without replacing either path.
 for(let i=0;i<2;i++){
  const prefetched=f.runtime.worker.tick.length?await f.runtime.store.claim():undefined;
  await f.runtime.worker.tick(prefetched);
 }
 await nextTurn();await nextTurn();
 for(const [owner,attempt] of [[ownerA,a],[ownerB,b]]){
  const events=f.calls.filter(x=>x.receipt.jobId===attempt.jobId);
  assert.ok(events.some(x=>x.receipt.data.phase==='started'));
  assert.equal(events.filter(x=>x.receipt.data.phase==='completed').length,1);
  for(const event of events){assert.equal(event.scope.ownerId,owner);assert.equal(event.scope.runNo,1);assert.equal(event.receipt.attemptId,attempt.attemptId);}
  const completed=events.find(x=>x.receipt.data.phase==='completed');assert.equal(completed.receipt.data.expectedCount,3);assert.equal(completed.receipt.data.receivedCount,3);
  const read=await f.runtime.store.attempt(scope(owner),attempt.attemptId);assert.equal(read.status,'done');assert.equal(read.snapshot.notes,body.notes);
 }
 assert.equal((await f.runtime.store.draft(scope(ownerA))).runNo,2);
 assert.equal(JSON.stringify(f.calls).includes(body.notes),false);assert.equal(JSON.stringify(f.calls).includes('approved U1'),false);
});

test('a rejected native finish produces no completed log; unknown AI outcome keeps needs_review',async t=>{
 const f=await setup(t),attempt=await submit(f,ownerA),job=await f.runtime.store.claim();
 const diagnostic=createHomeworkWorkerJournal({db:f.db,store:f.runtime.store,journal:f.journal,content:lesson('67-listening-fixture'),expectedCount:3});
 diagnostic.onStart(job);
 const prepared=f.runtime.grader.prepareWeb(job.answers,job.jobId);
 const valid=await f.runtime.grader.finish(prepared,{onCheckpoint:s=>diagnostic.store.validation.checkpoint(job,s),onRound:e=>diagnostic.store.validation.round(job,e)});
 const mismatched={...valid,context:{...valid.context,operationId:randomUUID()}};
 await assert.rejects(diagnostic.store.finish(job,mismatched),e=>e.code==='RESULT_IDENTITY_MISMATCH');
 await diagnostic.store.fail(job,{code:'AI_OUTCOME_UNKNOWN',message:'PRIVATE-AI-ERROR-CANARY'});await nextTurn();await nextTurn();
 assert.equal(f.calls.some(x=>x.receipt.data.phase==='completed'),false);
 assert.ok(f.calls.some(x=>x.receipt.data.phase==='failed'&&x.receipt.data.status==='needs_review'));
 assert.equal((await f.runtime.store.attempt(scope(ownerA),attempt.attemptId)).status,'needs_review');
 assert.equal(JSON.stringify(f.calls).includes('PRIVATE-AI-ERROR-CANARY'),false);
});

test('AI round intent/receipt/checkpoint logs only after their native writes and excludes response/prompt bodies',async t=>{
 const f=await setup(t);await submit(f,ownerA);const job=await f.runtime.store.claim();
 const diagnostic=createHomeworkWorkerJournal({db:f.db,store:f.runtime.store,journal:f.journal,content:lesson('67-listening-fixture'),expectedCount:3});
 const callId=randomUUID(),base={callId,phase:'audit',round:1,validationVersion:f.runtime.grader.validationVersion};
 diagnostic.onStart(job);
 await diagnostic.store.validation.round(job,{...base,status:'calling',promptHash:'a'.repeat(64)});
 await diagnostic.store.validation.round(job,{...base,status:'received',response:{text:'PRIVATE-PROVIDER-CANARY'},usage:{totalTokens:12}});
 await diagnostic.store.validation.checkpoint(job,{version:f.runtime.grader.validationVersion,phase:'review',round:1,lastCallId:callId});
 await nextTurn();await nextTurn();
 assert.deepEqual(f.calls.filter(x=>x.receipt.data.phase==='round').map(x=>x.receipt.data.status),['calling','received']);
 assert.ok(f.calls.filter(x=>['round','checkpoint'].includes(x.receipt.data.phase)).every(x=>x.receipt.data.callId===callId));
 assert.ok(f.calls.some(x=>x.receipt.data.phase==='checkpoint'&&x.receipt.data.roundNo===1));
 const row=(await f.db.query('SELECT status,response FROM reading_listening67.web_validation_round WHERE call_id=$1',[callId])).rows[0];
 assert.equal(row.status,'applied');assert.equal(row.response.text,'PRIVATE-PROVIDER-CANARY');
 assert.equal(JSON.stringify(f.calls).includes('PRIVATE-PROVIDER-CANARY'),false);assert.equal(JSON.stringify(f.calls).includes('a'.repeat(64)),false);
});

test('stalled journal delivery cannot block the grader; Listening context uses its own response field',async t=>{
 const f=await setup(t,{stalled:true});await submit(f,ownerA);await f.runtime.worker.tick();await nextTurn();
 assert.ok(f.calls.some(x=>x.receipt.data.phase==='completed'));
 const reply=await request(f.runtime.app).get(prefix+'/draft').set('Authorization','Bearer fixture-a');
 assert.equal(reply.status,200);assert.equal(reply.body.listeningJournal.ownerId,ownerA);assert.equal(reply.body.readingJournal,undefined);
});
