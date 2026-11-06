import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setImmediate as tick} from 'node:timers/promises';
import {createHomeworkWorkerJournal} from '../src/reading-listening67/web-journal-worker.js';
import {createHomeworkDocsJournal} from '../src/reading-listening67/web-journal-docs.js';
import {startHomeworkJournal} from '../src/reading-listening67/web-journal-runtime.js';

const scope={ownerId:randomUUID(),courseId:'fixture-class',code:'67-reading-fixture',version:'fixture-v1',runNo:1};
const job=()=>({jobId:randomUUID(),attemptId:randomUUID(),ownerId:scope.ownerId,leaseToken:randomUUID()});
const row={owner_id:scope.ownerId,course_id:scope.courseId,assignment_code:scope.code,content_version:scope.version,run_no:1};

test('worker registers the entire deferred SQL lookup and reuses its immutable scope before closing',async()=>{
 const pending=[],calls=[];let queries=0,finished=false,release;
 const gate=new Promise(resolve=>release=resolve);
 const journal={scheduleSource:work=>(pending.push(work),true),worker:(s,r)=>(calls.push({scope:s,receipt:r}),{ok:true})};
 const db={async query(sql,args){queries++;assert.ok(sql.includes('j.lease_token=$4'));assert.equal(args[2],scope.ownerId);await gate;return{rows:[row]};}};
 const native={finish:async()=>{finished=true;return'committed';}};
 const diagnostic=createHomeworkWorkerJournal({db,store:native,journal,content:scope,expectedCount:2}),j=job();
 diagnostic.onStart(j);assert.equal(pending.length,1);assert.equal(queries,0);
 assert.equal(await diagnostic.store.finish(j,{grading:{target_results:[{},{}]}}),'committed');
 assert.equal(finished,true);assert.equal(pending.length,2);await tick();assert.equal(queries,0);
 const draining=Promise.all(pending.map(work=>work()));await tick();assert.equal(queries,1);assert.equal(calls.length,0);
 release();await draining;assert.equal(calls.length,2);assert.ok(calls.every(value=>value.scope.ownerId===scope.ownerId));
 assert.deepEqual(calls.map(value=>value.receipt.data.phase),['started','completed']);
});

test('full worker barrier cannot start untracked SQL; an unverifiable scope returns failure',async()=>{
 let queries=0,events=0;const pending=[],j=job();
 const db={async query(){queries++;return{rows:[]};}},native={finish:async()=>'saved'};
 const journal={scheduleSource:()=>false,worker:()=>events++};
 let diagnostic=createHomeworkWorkerJournal({db,store:native,journal,content:scope});
 diagnostic.onStart(j);assert.equal(await diagnostic.store.finish(j,{}),'saved');await tick();assert.equal(queries,0);assert.equal(events,0);
 journal.scheduleSource=work=>(pending.push(work),true);
 diagnostic=createHomeworkWorkerJournal({db,store:native,journal,content:scope});diagnostic.onStart(j);
 assert.deepEqual(await pending.shift()(),{ok:false});assert.equal(queries,1);assert.equal(events,0);
});

test('Docs receipts stay in the barrier without retaining private payloads or falling back on refusal',async()=>{
 const pending=[],calls=[];let reject=false;
 const journal={scheduleSource(work){if(reject)return false;pending.push(work);return true;},docs:(s,r)=>(calls.push({scope:s,receipt:r}),{ok:true})};
 const diagnostic=createHomeworkDocsJournal({journal,metadata:scope}),j={id:randomUUID(),kind:'status',sequence:1,attempts:1,
  leaseId:randomUUID(),created_at:new Date().toISOString(),payload:{runNo:1,attemptId:randomUUID(),text:'PRIVATE-CANARY',url:'https://private.invalid/token'}};
 const observer=diagnostic.start(scope,j);observer.resolved({documentId:'PRIVATE-DOC',tabId:'PRIVATE-TAB'});observer.finish('verified');
 assert.equal(pending.length,4);await tick();assert.equal(calls.length,0);
 while(pending.length)await pending.shift()();assert.equal(calls.at(-1).receipt.data.phase,'verified');
 assert.equal(JSON.stringify(calls).includes('PRIVATE'),false);
 reject=true;diagnostic.queued(scope,j);await tick();assert.equal(calls.length,4);
});

test('disabled Homework bridge does not read or import private logger configuration',async()=>{
 const env={EXAM_JOURNAL_ENABLED:'0',get EXAM_JOURNAL_LIBRARY_ROOT(){throw Error('must not import');}};
 assert.equal(await startHomeworkJournal({productId:'reading-homework',origins:[],env}),null);
});
