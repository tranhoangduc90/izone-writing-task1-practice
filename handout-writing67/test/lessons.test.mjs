// Kiểm qua API và database thật cục bộ: cùng HV nhưng hai lesson có bài/rubric riêng.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createStore} from '../src/store.mjs';
import {createService} from '../src/service.mjs';
import {createTeacher} from '../src/teacher.mjs';
import {createApi} from '../src/http.mjs';

test('H67-LESSONS · bài, prompt, hàng chờ và bảng GV tách đúng lesson',async t=>{
 const db=new PGlite();for(const name of ['001-initial','002-activity-log'])await db.exec(await readFile(new URL('../db/'+name+'.sql',import.meta.url),'utf8'));
 const store=createStore(db),roster=async()=>[{classRef:'IC2304',className:'IC2304',students:[{studentRef:'fixture',displayName:'Học viên thử'}]},{classRef:'OTHER',className:'Lớp khác',students:[{studentRef:'fixture',displayName:'Học viên thử'}]}];
 const lessons={lesson5:{activity:'lesson5',title:'Mua đồ không cần thiết',topic:'Shopping question',promptVersion:'lesson5-rubric-v3',classes:['IC2304','OTHER']},lesson7:{activity:'lesson7',title:'Trao đổi thông tin',topic:'Information question',promptVersion:'lesson7-rubric-v1',classes:['IC2304']}};
 const service=createService({store,roster,secret:'s'.repeat(40),lessons,renderJob:j=>j.promptVersion+' '+j.snapshot.topic});
 const teacher=createTeacher({db,store,roster,lessons,secret:'t'.repeat(40),registry:()=>({}),verifyGoogleToken:async()=>({})});
 const server=createApi({service,teacher,origins:['http://127.0.0.1:8785'],internalSecret:'i'.repeat(40)});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>server.close(r));await db.close();});
 const base='http://127.0.0.1:'+server.address().port+'/api/handout67/v1';
 async function call(path,method='GET',body,token){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,value:await r.json()};}
 const who={};for(const activity of ['lesson5','lesson7']){const r=await call('/sessions','POST',{activity,classRef:'IC2304',studentRef:'fixture'});assert.equal(r.status,201);who[activity]=r.value;}
 assert.notEqual(who.lesson5.session.ref,who.lesson7.session.ref);
 for(const activity of ['lesson5','lesson7']){
  const {session,token}=who[activity];assert.equal((await call('/sessions/'+session.ref+'/responses','PUT',{baseVersion:0,requestId:'save',responses:{idea1:activity+' one',idea2:activity+' two',topicSentence:activity+' topic'}},token)).status,200);
  assert.equal((await call('/sessions/'+session.ref+'/checks','POST',{section:'topic',baseVersion:1,requestId:'check'},token)).status,202);
 }
 const jobs=(await call('/internal/jobs/claim','POST',{},'i'.repeat(40))).value.jobs;assert.equal(jobs.length,1);
 const second=(await call('/internal/jobs/claim','POST',{},'i'.repeat(40))).value.jobs;assert.equal(second.length,1);
 for(const job of [...jobs,...second]){const activity=job.sessionRef===who.lesson5.session.ref?'lesson5':'lesson7';assert.equal(job.promptVersion,lessons[activity].promptVersion);assert.equal(job.snapshot.topic,lessons[activity].topic);assert.equal(job.prompt,lessons[activity].promptVersion+' '+lessons[activity].topic);}
 const actor={classes:['IC2304','OTHER'],email:'fixture@example.com',displayName:'GV thử'};
 for(const activity of ['lesson5','lesson7']){const s=await teacher.summary(actor,'IC2304',activity);assert.equal(s.students[0].sessionRef,who[activity].session.ref);const d=await teacher.detail(actor,who[activity].session.ref);assert.equal(d.activity,activity);}
 assert.deepEqual((await call('/roster?activity=lesson7')).value.classes.map(c=>c.classRef),['IC2304']);
 assert.equal((await call('/sessions','POST',{activity:'lesson7',classRef:'OTHER',studentRef:'fixture'})).status,403);
 assert.equal((await call('/lessons/lesson7')).value.lesson.topic,'Information question');
 assert.equal((await call('/sessions','POST',{activity:'lesson99',classRef:'IC2304',studentRef:'fixture'})).status,404);
 assert.equal((await call('/sessions/'+who.lesson7.session.ref,'GET',undefined,who.lesson5.token)).status,401);
 const again=(await call('/sessions','POST',{activity:'lesson7',classRef:'IC2304',studentRef:'fixture'})).value;assert.equal(again.session.ref,who.lesson7.session.ref);assert.equal(again.session.responses.idea1,'lesson7 one');
});
