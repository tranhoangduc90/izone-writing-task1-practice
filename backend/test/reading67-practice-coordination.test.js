import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createReadingSharePractice,createReadingShareWorker} from '../src/reading-listening67/web-share-practice.js';
import {claimWebWorkBatch,releaseUnstartedWebWork} from '../src/reading-listening67/web-work-claims.js';
import {createWebWorkCoordinator,selectReadyWebScopes} from '../src/reading-listening67/web-work-coordinator.js';
import {readWebObservations,observationKey} from '../src/reading-listening67/web-observation-store.js';

const A={code:'practice-A',version:'v1'},B={code:'practice-B',version:'v2'};
const scope=(lesson=A)=>({...lesson,ownerId:randomUUID(),courseId:'class'}),url=()=> 'https://chatgpt.com/share/'+randomUUID();
const outcome={status:'accepted',policy:'reading-skimming-l1-share-20261029-v1',message:'Đã xác minh đúng bài.'};
async function fixture(t){
 const raw=new PGlite();await raw.exec('CREATE SCHEMA reading_listening67');await raw.exec(await fs.readFile(new URL('../../docs/migrations/2026-10-29-reading67-share-practice.sql',import.meta.url),'utf8'));t.after(()=>raw.close());
 const wakes=[],db={query:(...a)=>raw.query(...a),async transaction(fn){const callbacks=[];const result=await raw.transaction(tx=>fn({query:(...a)=>tx.query(...a),afterCommit:cb=>callbacks.push(cb)}));for(const cb of callbacks)try{cb();}catch{}return result;},wakeWork:lane=>wakes.push(lane)};
 const service=(lesson=A,extra={})=>createReadingSharePractice({db,content:{...lesson,practice:{target:'Nén cấp 1'}},readShare:async()=>({messages:[{role:'user',text:'Nội dung giả dùng kiểm hàng chờ.'}]}),verify:async()=>outcome,...extra});
 return {raw,db,wakes,service};
}

test('Practice admission isolates versions, replays saved AI responses and quarantines unknown expired work',async t=>{
 const {db,service}=await fixture(t),a=service(),b=service(B);let verified=0,read=0;
 const worker=service(A,{readShare:async()=>{read++;throw Error('SHOULD_REPLAY_SNAPSHOT');},verify:async()=>{verified++;return outcome;}});
 const expired=scope(),unknown=scope(),hidden=scope({...A,version:'hidden'}),queuedB=scope(B);
 await a.save(expired,{url:url(),requestId:randomUUID()});await a.save(unknown,{url:url(),requestId:randomUUID()});await b.save(queuedB,{url:url(),requestId:randomUUID()});await service(hidden).save(hidden,{url:url(),requestId:randomUUID()});
 await db.query("UPDATE reading_listening67.web_share_practice SET status='processing',lease_token=$1,lease_until=now()-interval '1 second',analysis_intent=true WHERE owner_id=ANY($2::uuid[])",[randomUUID(),[expired.ownerId,unknown.ownerId]]);
 await db.query('UPDATE reading_listening67.web_share_practice SET snapshot=$2,analysis_response=$3 WHERE owner_id=$1',[expired.ownerId,{messages:[{role:'user',text:'Bản đã lưu trước ngắt kết nối.'}]},outcome]);
 const batch=await claimWebWorkBatch(db,'practice',[A,B]);assert.equal(batch.length,2);assert.equal(new Set(batch.map(x=>x.code)).size,2);assert.equal((await a.status(unknown)).status,'needs_review');assert.equal((await service(hidden).status(hidden)).status,'queued');
 await worker.once(batch.find(x=>x.code===A.code).job);assert.equal((await a.status(expired)).status,'accepted');assert.equal(verified,0);assert.equal(read,0);
 await assert.rejects(()=>worker.once(batch.find(x=>x.code===B.code).job),{code:'SHARE_SCOPE_CHANGED'});
 await releaseUnstartedWebWork(db,'practice',batch.filter(x=>x.code===B.code));assert.equal((await b.status(queuedB)).status,'queued');
});

test('Practice batch takes one job per free scope; owned release keeps every native checkpoint and receipt',async t=>{
 const {db,service}=await fixture(t),a=service(),people=[scope(),scope()];for(const p of people)await a.save(p,{url:url(),requestId:randomUUID()});
 const batch=await claimWebWorkBatch(db,'practice',[A]);assert.equal(batch.length,1);const job=batch[0].job;
 await releaseUnstartedWebWork(db,'practice',[{...batch[0],job:{...job,lease_token:randomUUID()}}]);assert.equal((await db.query('SELECT status FROM reading_listening67.web_share_practice WHERE id=$1',[job.id])).rows[0].status,'processing');
 await releaseUnstartedWebWork(db,'practice',batch);const after=(await db.query('SELECT * FROM reading_listening67.web_share_practice WHERE id=$1',[job.id])).rows[0];
 for(const field of ['id','request_id','share_url','snapshot','analysis_intent','analysis_response','outcome'])assert.deepEqual(after[field],job[field]);assert.equal(after.status,'queued');assert.equal(after.lease_token,null);
 assert.equal((await selectReadyWebScopes(db,'practice',[A,B])).length,1);
});

test('Only committed new links wake practice; duplicate, rollback and notifier failure preserve native save semantics',async t=>{
 const {db,wakes,service}=await fixture(t),a=service(),p=scope(),requestId=randomUUID(),link=url();
 await a.save(p,{url:link,requestId});assert.deepEqual(wakes,['practice']);await a.save(p,{url:link,requestId});await a.save(p,{url:link,requestId:randomUUID()});assert.equal(wakes.length,1);
 const original=db.transaction;db.transaction=fn=>original(async tx=>{await fn(tx);throw Error('ROLLBACK_FIXTURE');});await assert.rejects(()=>a.save(scope(),{url:url(),requestId:randomUUID()}),/ROLLBACK_FIXTURE/);assert.equal(wakes.length,1);db.transaction=original;
 db.wakeWork=()=>{throw Error('NOTIFIER_DOWN');};const next=await a.save(p,{url:url(),requestId:randomUUID()});assert.equal(next.status,'queued');assert.equal((await a.status(p)).id,next.id);
});

test('Practice coordinator keeps 1000 ms recovery and admits peers while another reader is slow',async t=>{
 const {db,service}=await fixture(t);let release,started;const gate=new Promise(r=>release=r),entered=new Promise(r=>started=r),p=scope(),other=scope(B);
 const a=service(A,{readShare:async()=>{started();await gate;return {messages:[{role:'user',text:'Bản giả'}]};}}),b=service(B);await a.save(p,{url:url(),requestId:randomUUID()});await b.save(other,{url:url(),requestId:randomUUID()});
 const timers=[],coordinator=createWebWorkCoordinator({db,setTimer(fn,delay){const id=setTimeout(fn,delay);timers.push(delay);return id;}});t.after(()=>coordinator.close());db.workCoordinator=coordinator;
 const workers=[createReadingShareWorker({practice:service(A,{readShare:async()=>{started();await gate;return {messages:[{role:'user',text:'Bản giả'}]};}})}),createReadingShareWorker({practice:service(B)})];
 for(const worker of workers)worker.start();await entered;
 try{const end=Date.now()+3000;while((await b.status(other)).status!=='accepted'&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.equal((await b.status(other)).status,'accepted');assert.equal((await a.status(p)).status,'processing');assert.ok(timers.includes(1000));}finally{release();await Promise.all(workers.map(w=>w.close()));}
});

test('One observation read returns live practice and the selected immutable snapshot without transcript or another owner',async t=>{
 const {raw,db,service}=await fixture(t);await raw.exec(await fs.readFile(new URL('../ops/listening-homework67/schema.sql',import.meta.url),'utf8'));
 const a=service(),p={...scope(),practice:true},other={...p,ownerId:randomUUID()},attemptId=randomUUID();await a.save(p,{url:url(),requestId:randomUUID()});
 await db.query("UPDATE reading_listening67.web_share_practice SET status='accepted',snapshot=$1,analysis_response=$2,outcome=$2",[{secret:'PRIVATE_TRANSCRIPT_NEVER_IN_FRAME'},outcome]);
 await db.query("INSERT INTO reading_listening67.web_attempt(id,owner_id,course_id,assignment_code,content_version,draft_revision,snapshot,input_hash,grader_hash,completeness) VALUES($1,$2,$3,$4,$5,1,'{}','hash','grader','{}')",[attemptId,p.ownerId,p.courseId,p.code,p.version]);
 await raw.transaction(tx=>a.attachAttempt(tx,p,attemptId));const old=await a.status(p,attemptId);
 await a.save(p,{url:url(),requestId:randomUUID()});const selected={...p,attemptId};let reads=0;const watched={query(...args){reads++;return db.query(...args);}};
 const observed=await readWebObservations(watched,{scopes:[p,selected,{...other,attemptId}],guards:[],documents:[]});assert.equal(reads,1);
 assert.equal(observed.states.get(observationKey(selected)).practice.status,'queued');assert.deepEqual(observed.states.get(observationKey(selected)).attemptPractice,old);
 assert.equal(observed.states.get(observationKey({...other,attemptId})).attemptMissing,true);assert.equal(observed.states.get(observationKey({...other,attemptId})).practice.status,'not_started');assert.equal(JSON.stringify([...observed.states]).includes('PRIVATE_TRANSCRIPT_NEVER_IN_FRAME'),false);
});
