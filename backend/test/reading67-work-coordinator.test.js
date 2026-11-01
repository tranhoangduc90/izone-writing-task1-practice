import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createWebWorkCoordinator,selectReadyWebScopes} from '../src/reading-listening67/web-work-coordinator.js';

const A={code:'fixture-A',version:'v1',validation:true};
const B={code:'fixture-B',version:'v2',validation:false};
const key=s=>JSON.stringify([s.code,s.version]);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fakeClock(){
 let now=0,id=0;const pending=new Map();
 return {clock:()=>now,setTimer(fn,delay){const timer={id:++id,unref(){}};pending.set(timer.id,{timer,fn,at:now+delay});return timer;},clearTimer(timer){if(timer)pending.delete(timer.id);},
  async advance(ms){const target=now+ms;let steps=0;while(true){const next=[...pending.values()].filter(t=>t.at<=target).sort((a,b)=>a.at-b.at)[0];if(!next)break;if(++steps>100)throw Error('Timer loop');now=next.at;pending.delete(next.timer.id);next.fn();await settle();}now=target;await settle();}};
}
async function sqlFixture(t){
 const db=new PGlite();t.after(()=>db.close());
 await db.exec(await fs.readFile(new URL('../ops/listening-homework67/schema.sql',import.meta.url),'utf8'));
 async function grading(scope,{status='queued',future=false}={}){
  const attempt=randomUUID(),job=randomUUID();
  await db.query('INSERT INTO reading_listening67.web_attempt(id,owner_id,course_id,assignment_code,content_version,draft_revision,snapshot,input_hash,grader_hash,completeness) VALUES($1,$2,$3,$4,$5,1,$6,$7,$8,$9)',[attempt,randomUUID(),'class',scope.code,scope.version,{},'hash','grader',{}]);
  await db.query('INSERT INTO reading_listening67.web_job(id,attempt_id,status) VALUES($1,$2,$3)',[job,attempt,status]);
  if(future)await db.query("INSERT INTO reading_listening67.web_validation(job_id,next_attempt_at) VALUES($1,now()+interval '1 hour')",[job]);
  return job;
 }
 async function binding(scope){const id=randomUUID();await db.query('INSERT INTO reading_listening67.web_homework_binding(id,owner_id,course_id,assignment_code,content_version) VALUES($1,$2,$3,$4,$5)',[id,randomUUID(),'class',scope.code,scope.version]);return id;}
 async function docs(bindingId,sequence,{status='pending',future=false,lease=false}={}){await db.query("INSERT INTO reading_listening67.web_homework_job(id,binding_id,event_key,sequence,kind,payload,status,available_at,lease_until) VALUES($1,$2,$3,$4,'status','{}',$5,now()+$6*interval '1 hour',CASE WHEN $7 THEN now()-interval '1 second' ELSE NULL END)",[randomUUID(),bindingId,'event-'+sequence,sequence,status,future?1:0,lease]);}
 return {db,grading,binding,docs};
}

test('SQL admission reads only registered lesson versions, respects validation retry time and does not mutate jobs',async t=>{
 const {db,grading}=await sqlFixture(t);
 await grading(A);await grading(B);await grading({...A,version:'other'});await grading({code:'private',version:'v1'});await grading({...A,code:'future'},{future:true});await grading({...A,code:'busy'},{status:'processing'});
 const scopes=[A,B,{...A,code:'future'},{...A,code:'busy'}];
 const before=(await db.query('SELECT id,status,lease_token FROM reading_listening67.web_job ORDER BY id')).rows;
 assert.deepEqual(new Set((await selectReadyWebScopes(db,'grading',scopes)).map(key)),new Set([key(A),key(B)]));
 assert.deepEqual((await db.query('SELECT id,status,lease_token FROM reading_listening67.web_job ORDER BY id')).rows,before);
 assert.deepEqual(await selectReadyWebScopes(db,'grading',[]),[]);
});

test('SQL Docs admission preserves sequence, blocked predecessors, due time and expired leases',async t=>{
 const {db,binding,docs}=await sqlFixture(t);
 const a=await binding(A);await docs(a,0,{status:'blocked'});await docs(a,1);
 const b=await binding(B);await docs(b,0,{status:'verified'});await docs(b,1,{status:'processing',lease:true});
 const later={code:'later',version:'v1'},c=await binding(later);await docs(c,0,{future:true});
 const hidden=await binding({code:'hidden',version:'v1'});await docs(hidden,0);
 assert.deepEqual((await selectReadyWebScopes(db,'docs',[A,B,later])).map(key),[key(B)]);
 await db.query("UPDATE reading_listening67.web_homework_job SET status='verified' WHERE binding_id=$1 AND sequence=0",[a]);
 assert.deepEqual(new Set((await selectReadyWebScopes(db,'docs',[A,B,later])).map(key)),new Set([key(A),key(B)]));
});

test('Six empty lessons share one admission query every 500 ms without invoking native claims',async()=>{
 const time=fakeClock(),calls=[];let claims=0;
 const runner=createWebWorkCoordinator({db:{async query(sql,args){calls.push(JSON.parse(args[0]));return {rows:[]};}},...time});
 for(let n=0;n<6;n++)runner.register({lane:'docs',scope:{code:'lesson-'+n,version:'v1'},run:async()=>{claims++;}});
 await time.advance(1500);
 assert.equal(calls.length,4);assert.ok(calls.every(scopes=>scopes.length===6));assert.equal(claims,0);
 await runner.close();await time.advance(2000);assert.equal(calls.length,4);
});

test('Slow AI work cannot block a ready peer, and repeated wakes never overlap the same scope',async()=>{
 const time=fakeClock(),ready=new Set([key(A),key(B)]),calls=[];let release;
 const waiting=new Promise(resolve=>release=resolve);
 const runner=createWebWorkCoordinator({db:{async query(_sql,args){return {rows:JSON.parse(args[0]).filter(s=>ready.has(key(s)))};}},...time});
 runner.register({lane:'grading',scope:A,run:async()=>{calls.push('A-start');ready.delete(key(A));await waiting;calls.push('A-end');return true;}});
 runner.register({lane:'grading',scope:B,run:async()=>{calls.push('B');ready.delete(key(B));return true;}});
 await time.advance(0);assert.deepEqual(calls,['A-start','B']);
 ready.add(key(B));runner.wake('grading');runner.wake('grading');await time.advance(0);
 assert.deepEqual(calls,['A-start','B','B']);assert.equal(runner.snapshot().lanes[0].running,1);
 release();await settle();await time.advance(0);assert.equal(calls.at(-1),'A-end');await runner.close();
});

test('Selector outage is visible and falls back to native scoped claims at the original interval',async()=>{
 const time=fakeClock(),runs=[],errors=[];
 const runner=createWebWorkCoordinator({db:{async query(){throw Error('SELECTOR_UNAVAILABLE');}},...time});
 for(const scope of [A,B])runner.register({lane:'docs',scope,run:async()=>{runs.push(scope.code);return false;},onError:e=>errors.push(e.message)});
 await time.advance(500);assert.deepEqual(runs,['fixture-A','fixture-B','fixture-A','fixture-B']);assert.equal(errors.length,4);assert.equal(runner.snapshot().lanes[0].degraded,2);await runner.close();
});

test('Deregistration prevents late selection from running a closed adapter',async()=>{
 const time=fakeClock();let maintained=0,ran=0,release,initial=true;
 const delayed=new Promise(resolve=>release=resolve);
 const runner=createWebWorkCoordinator({db:{async query(){if(initial){initial=false;await delayed;}return {rows:[A]};}},...time});
 const handle=runner.register({lane:'grading',scope:A,run:async()=>{ran++;return false;},maintain:async()=>{maintained++;}});
 assert.throws(()=>runner.register({lane:'grading',scope:A,run(){}}),/ALREADY_REGISTERED/);
 await time.advance(0);assert.equal(maintained,1);await handle.close();release();await settle();assert.equal(ran,0);await runner.close();await time.advance(30000);assert.equal(maintained,1);
});

test('Expired-work maintenance retains its 30-second interval and reporting failures cannot stop the runner',async()=>{
 const time=fakeClock();let maintained=0;
 const runner=createWebWorkCoordinator({db:{async query(){return {rows:[]};}},...time});
 runner.register({lane:'grading',scope:A,run:async()=>false,maintain:async()=>{maintained++;if(maintained===1)throw Error('RECOVERY_READ_FAILED');},onError(){throw Error('LOGGER_FAILED');}});
 await time.advance(30000);assert.equal(maintained,2);assert.equal(runner.snapshot().lanes[0].scans,41);
 await time.advance(750);assert.equal(maintained,3);await runner.close();
});
