// Trạng thái dùng chung: SQL thật kiểm scope/revision; đồng hồ giả kiểm nhiều tab/lỗi/chờ.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {readWebObservations,observationKey} from '../src/reading-listening67/web-observation-store.js';
import {createWebObservationHub} from '../src/reading-listening67/web-observation-hub.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
function fakeClock(){
 let now=Date.now(),id=0;const pending=new Map();
 return {clock:()=>now,setTimer(fn,delay){const timer={id:++id,unref(){}};pending.set(timer.id,{fn,at:now+delay});return timer;},clearTimer(timer){if(timer)pending.delete(timer.id);},
  async advance(ms){const target=now+ms;let steps=0;while(true){const next=[...pending].filter(([,v])=>v.at<=target).sort(([,a],[,b])=>a.at-b.at)[0];if(!next)break;if(++steps>100)throw Error('Timer loop');now=next[1].at;pending.delete(next[0]);next[1].fn();await settle();}now=target;await settle();}};
}
const scope=(code='fixture',owner=randomUUID())=>({ownerId:owner,courseId:'1124',code,version:'v1'});
const auth=(name='A')=>({kind:'student',hash:'hash-'+name,key:'guard-'+name,verify:async()=>({person:name})});
function snapshot(scopes,guards,status='queued'){
 return {states:new Map(scopes.map(s=>[observationKey(s),{attemptId:s.attemptId||'same-attempt',status,resultRevision:'r1',draftRevision:1,jobs:[]}])) ,sessions:new Map(guards.map(g=>[g.kind+':'+g.hash,{owner_id:g.hash}])),documents:new Map()};
}

test('REST status batches 50 simultaneous scopes and maps reordered results by immutable owner/class/lesson/attempt keys',async()=>{
 const time=fakeClock();let reads=0;
 const input=Array.from({length:50},(_,n)=>({...scope('lesson-'+n%2),courseId:String(1124+n%2),version:'v'+n%3,...(n%2?{attemptId:randomUUID(),practice:true}:{})}));
 const expected=input.map(s=>({...s}));
 const hub=createWebObservationHub({db:{},...time,read:async(_db,args)=>{reads++;const value=snapshot([...args.scopes].reverse(),[]);for(const s of args.scopes)value.states.get(observationKey(s)).marker=observationKey(s);return value;}});
 const requests=input.map(s=>hub.readOnce(s)),result=Promise.all(requests);void result.catch(()=>{});input[0].ownerId='changed-after-request';
 await time.advance(0);
 assert.equal(reads,1,'Concurrent REST polls must share the underlying state read');
 const results=await result;
 results.forEach((value,n)=>assert.equal(value.marker,observationKey(expected[n])));
 await hub.close();
});

test('REST status deduplicates an in-flight scope, propagates SQL errors and reads fresh data after recovery',async()=>{
 const time=fakeClock(),s=scope();let reads=0,failed=true,version='r1',hold=false,release;const gate=new Promise(r=>release=r);
 const hub=createWebObservationHub({db:{},...time,read:async(_db,args)=>{reads++;if(failed)throw Error('SQL_DOWN');if(hold)await gate;const value=snapshot(args.scopes,[]);for(const row of value.states.values())row.resultRevision=version;return value;}});
 const first=Promise.allSettled(Array.from({length:50},()=>hub.readOnce(s)));await time.advance(0);
 assert.ok((await first).every(x=>x.status==='rejected'&&x.reason.message==='SQL_DOWN'));assert.equal(reads,1);
 failed=false;hold=true;const recovered=hub.readOnce(s);await time.advance(0);const duplicate=hub.readOnce(s);release();await settle();assert.equal((await recovered).resultRevision,'r1');assert.equal((await duplicate).resultRevision,'r1');assert.equal(reads,2);
 version='r2';const fresh=hub.readOnce(s);await time.advance(0);assert.equal((await fresh).resultRevision,'r2');assert.equal(reads,3);
 await hub.close();
});

test('REST status close drains accepted reads without hanging or accepting new work',async()=>{
 const time=fakeClock();let release,reads=0;const gate=new Promise(r=>release=r);
 const hub=createWebObservationHub({db:{},...time,read:async(_db,args)=>{if(++reads===1)await gate;return snapshot(args.scopes,[]);}});
 const first=hub.readOnce(scope());await time.advance(0);const second=hub.readOnce(scope());let finished=false;
 const closing=hub.close().then(()=>{finished=true;});await settle();assert.equal(finished,false);
 release();await closing;assert.ok((await first).revision);assert.ok((await second).revision);
 await assert.rejects(hub.readOnce(scope()),/STATE_CLOSED/);
});

test('Observation SQL isolates owners, classes, lesson versions and explicit attempts while detecting result changes in the same attempt',async t=>{
 const db=new PGlite();t.after(()=>db.close());await db.exec(await fs.readFile(new URL('../ops/listening-homework67/schema.sql',import.meta.url),'utf8'));
 const a=scope(),b=scope('fixture'),id=randomUUID(),job=randomUUID();
 await db.query('INSERT INTO reading_listening67.web_draft(owner_id,course_id,assignment_code,content_version,revision) VALUES($1,$2,$3,$4,3)',[a.ownerId,a.courseId,a.code,a.version]);
 await db.query("INSERT INTO reading_listening67.web_attempt(id,owner_id,course_id,assignment_code,content_version,draft_revision,snapshot,input_hash,grader_hash,completeness) VALUES($1,$2,$3,$4,$5,1,$6,'hash','grader','{}')",[id,a.ownerId,a.courseId,a.code,a.version,{answers:{secret:'never in the stream'}}]);
 await db.query("INSERT INTO reading_listening67.web_job(id,attempt_id,status) VALUES($1,$2,'done')",[job,id]);await db.query('INSERT INTO reading_listening67.web_result(attempt_id,data) VALUES($1,$2)',[id,{feedback:{text:'first'}}]);
 const watched=[a,b,{...a,courseId:'other'},{...a,version:'other'},{...b,attemptId:id}];
 const before=await readWebObservations(db,{scopes:watched,guards:[],documents:[]});
 assert.equal(before.states.get(observationKey(a)).attemptId,id);assert.equal(before.states.get(observationKey(a)).draftRevision,3);
 for(const s of watched.slice(1))assert.equal(before.states.get(observationKey(s)).attemptId,null);
 assert.equal(before.states.get(observationKey(watched.at(-1))).attemptMissing,true);assert.equal(JSON.stringify([...before.states]).includes('never in the stream'),false);
 await db.query('UPDATE reading_listening67.web_result SET data=$2 WHERE attempt_id=$1',[id,{feedback:{text:'updated in same attempt'}}]);
 const after=await readWebObservations(db,{scopes:[a],guards:[],documents:[]});assert.notEqual(before.states.get(observationKey(a)).resultRevision,after.states.get(observationKey(a)).resultRevision);assert.equal(after.states.get(observationKey(a)).draftRevision,3);
 await db.query('INSERT INTO reading_listening67.web_validation(job_id,state) VALUES($1,$2)',[job,{phase:'review',round:1}]);
 const validation=await readWebObservations(db,{scopes:[a],guards:[],documents:[]});assert.notEqual(after.states.get(observationKey(a)).validationRevision,validation.states.get(observationKey(a)).validationRevision);
});

test('One shared cycle serves 100 tabs, coalesces identical guards, preserves unchanged revisions and revokes only the deleted session',async()=>{
 const time=fakeClock(),a=scope(),b=scope(),ga=auth(),gb=auth('B'),frames=Array.from({length:100},()=>[]);let reads=0,verified=0,changed=false,revoked=false;
 ga.verify=async()=>{verified++;return {};};
 const hub=createWebObservationHub({db:{},...time,read:async(_db,args)=>{reads++;assert.equal(new Set(args.scopes.map(observationKey)).size,2);const value=snapshot(args.scopes,args.guards);if(changed)for(const row of value.states.values())row.resultRevision='r2';if(revoked)value.sessions.delete('student:'+gb.hash);return value;}});
 for(let n=0;n<100;n++)hub.subscribe({scope:n===99?b:a,guard:n===99?gb:ga,send:(event,value)=>frames[n].push({event,value})});
 await time.advance(4500);assert.equal(reads,4);assert.equal(verified,4);assert.ok(frames.every(f=>f.length===1));
 changed=true;await time.advance(1500);assert.ok(frames.every(f=>f.length===2));
 revoked=true;await time.advance(1500);assert.equal(frames[99].at(-1).event,'access_revoked');assert.equal(hub.snapshot().connections,99);assert.equal(frames[0].length,2);
 await hub.close();const count=reads;await time.advance(30000);assert.equal(reads,count);
});

test('A slow authority never holds another learner, and a late guard cannot publish after native session revocation',async()=>{
 const time=fakeClock(),a=scope(),b=scope(),ga=auth(),gb=auth('B'),framesA=[],framesB=[];let release,revoked=false,version='r1';const wait=new Promise(resolve=>release=resolve);
 ga.verify=async()=>{await wait;return {};};
 const hub=createWebObservationHub({db:{},...time,read:async(_db,args)=>{const value=snapshot(args.scopes,args.guards);for(const row of value.states.values())row.resultRevision=version;if(revoked)value.sessions.delete('student:'+ga.hash);return value;}});
 hub.subscribe({scope:a,guard:ga,send:(event,value)=>framesA.push({event,value})});hub.subscribe({scope:b,guard:gb,send:(event,value)=>framesB.push({event,value})});
 await time.advance(0);assert.equal(framesA.length,0);assert.equal(framesB.length,1);
 version='r2';await time.advance(1500);assert.equal(framesB.length,2);revoked=true;await time.advance(1500);assert.equal(framesA.at(-1).event,'access_revoked');
 release();await settle();assert.equal(framesA.some(f=>f.event==='state'),false);await hub.close();
});

test('Transient SQL failure stays unavailable and a pending authority cannot replay stale data; recovery resends a fresh snapshot',async()=>{
 const time=fakeClock(),s=scope(),guard=auth(),frames=[];let release,failed=false,calls=0;
 const wait=new Promise(resolve=>release=resolve);guard.verify=async()=>{if(++calls===1)await wait;return {};};
 const hub=createWebObservationHub({db:{},...time,read:async(_db,args)=>{if(failed)throw Error('SQL_DOWN');return snapshot(args.scopes,args.guards);}});
 hub.subscribe({scope:s,guard,send:(event,value)=>frames.push({event,value})});await time.advance(0);failed=true;await time.advance(1500);assert.equal(frames.at(-1).event,'unavailable');
 release();await settle();assert.equal(frames.some(f=>f.event==='state'),false);
 failed=false;await time.advance(1500);assert.equal(frames.at(-1).event,'state');await hub.close();
});

test('Closing an observer during a delayed shared read never launches its guard or sends late data',async()=>{
 const time=fakeClock(),s=scope(),guard=auth(),frames=[];let release,checks=0;
 const wait=new Promise(resolve=>release=resolve);guard.verify=async()=>{checks++;return {};};
 const hub=createWebObservationHub({db:{},...time,read:async(_db,args)=>{await wait;return snapshot(args.scopes,args.guards);}});
 const observer=hub.subscribe({scope:s,guard,send:(event,value)=>frames.push({event,value})});await time.advance(0);observer.close();release();await settle();await hub.close();assert.equal(checks,0);assert.deepEqual(frames,[]);
});
