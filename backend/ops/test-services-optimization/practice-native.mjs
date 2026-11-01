import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {createReading67Postgres} from '../../src/reading-listening67/web-postgres.js';
import {createReadingSharePractice} from '../../src/reading-listening67/web-share-practice.js';
import {claimWebWorkBatch} from '../../src/reading-listening67/web-work-claims.js';
import {readWebObservations,observationKey} from '../../src/reading-listening67/web-observation-store.js';

export function registerPracticeNativeTests({db,connectionString}){
 test('Native practice: concurrent batch locks, peer wake after commit, unknown quarantine and immutable snapshot',async t=>{
  await db.query(await fs.readFile(new URL('./fixtures/share-practice.sql',import.meta.url),'utf8'));
  const peer=createReading67Postgres({connectionString,max:3,workCoordinatorEnabled:true}),writer=createReading67Postgres({connectionString,max:3,workCoordinatorEnabled:true});t.after(async()=>{await writer.close();await peer.close();});
  const code='native-practice-'+randomUUID(),content={code,version:'v1',practice:{target:'Nén cấp 1'}},scope={ownerId:randomUUID(),courseId:'class',code,version:'v1'},outcome={status:'accepted',policy:'reading-skimming-l1-share-20261029-v1',message:'Đã kiểm · dữ liệu giả.'};let calls=0;
  const a=createReadingSharePractice({db:writer,content,readShare:async()=>({messages:[{role:'user',text:'Bản giả kiểm lưu.'}]}),verify:async()=>{calls++;return outcome;}});
  const end=Date.now()+5000;while((!peer.workSignals.snapshot().connected||!writer.workSignals.snapshot().connected)&&Date.now()<end)await new Promise(r=>setTimeout(r,10));assert.ok(peer.workSignals.snapshot().connected&&writer.workSignals.snapshot().connected);
  const received=peer.workSignals.snapshot().received;await a.save(scope,{url:'https://chatgpt.com/share/'+randomUUID(),requestId:randomUUID()});
  const wakeEnd=Date.now()+5000;while(peer.workSignals.snapshot().received===received&&Date.now()<wakeEnd)await new Promise(r=>setTimeout(r,10));assert.ok(peer.workSignals.snapshot().received>received);assert.equal((await a.status(scope)).status,'queued');
  const [left,right]=await Promise.all([claimWebWorkBatch(writer,'practice',[content]),claimWebWorkBatch(peer,'practice',[content])]),claims=[...left,...right];assert.equal(claims.length,1);await a.once(claims[0].job);assert.equal(calls,1);
  const attemptId=randomUUID();await db.query("INSERT INTO reading_listening67.web_attempt(id,owner_id,course_id,assignment_code,content_version,draft_revision,snapshot,input_hash,grader_hash,completeness) VALUES($1,$2,$3,$4,$5,1,'{}','hash','grader','{}')",[attemptId,scope.ownerId,scope.courseId,scope.code,scope.version]);await db.transaction(tx=>a.attachAttempt(tx,scope,attemptId));const snapshot=await a.status(scope,attemptId);
  await a.save(scope,{url:'https://chatgpt.com/share/'+randomUUID(),requestId:randomUUID()});await db.query("UPDATE reading_listening67.web_share_practice SET status='processing',analysis_intent=true,analysis_response=NULL,lease_token=$1,lease_until=now()-interval '1 second' WHERE assignment_code=$2",[randomUUID(),code]);assert.deepEqual(await claimWebWorkBatch(peer,'practice',[content]),[]);assert.equal((await a.status(scope)).status,'needs_review');assert.equal(calls,1);
  const watched={...scope,attemptId,practice:true},states=await readWebObservations(peer,{scopes:[watched],guards:[],documents:[]}),value=states.states.get(observationKey(watched));assert.equal(value.practice.status,'needs_review');assert.deepEqual(value.attemptPractice,JSON.parse(JSON.stringify(snapshot)));assert.equal(JSON.stringify(value).includes('Bản giả kiểm lưu.'),false);
 });
}
