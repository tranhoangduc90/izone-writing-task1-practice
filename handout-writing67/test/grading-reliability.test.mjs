import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createStore} from '../src/store.mjs';
import {createService} from '../src/service.mjs';
import {createApi} from '../src/http.mjs';
import {createProcessor,gatewayAdapter} from '../src/processor.mjs';

// Dùng API thật và PostgreSQL nhúng với học viên giả; không gọi AI/VPS production.
// Kỳ vọng từ lỗi lớp thật: kết quả có dấu bao phải được xử lý, pending phải kết thúc hữu hạn.
async function harness(t,extraStudents=[],processorOptions=null){
  const db=new PGlite();await db.exec(await readFile(new URL('../db/001-initial.sql',import.meta.url),'utf8'));
  const migration=new URL('../db/002-activity-log.sql',import.meta.url);
  if(existsSync(migration))await db.exec(await readFile(migration,'utf8'));
  let now=Date.parse('2026-10-06T00:00:00Z');
  const secret='fixture-reliability-'.padEnd(40,'s'),internalSecret='fixture-internal-'.padEnd(40,'i');
  const store=createStore(db,{clock:()=>now});
  const service=createService({store,secret,clock:()=>now,renderJob:processorOptions?()=> 'Rubric fixture tiếng Việt, không viết hộ học viên.':undefined,roster:async()=>[{classRef:'fixture-c67',students:[{studentRef:'fixture-a',displayName:'Học viên giả'},...extraStudents]}]});
  const processor=processorOptions?createProcessor({service,...processorOptions}):null;
  const server=createApi({service,processor,origins:['http://127.0.0.1'],internalSecret});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));await db.close();});
  const base=`http://127.0.0.1:${server.address().port}/api/handout67/v1`;
  const call=async(url,method='GET',body,token=internalSecret)=>{const r=await fetch(base+url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,body:await r.json()};};
  const opened=await call('/sessions','POST',{activity:'lesson5',classRef:'fixture-c67',studentRef:'fixture-a'});
  assert.equal(opened.status,201);const {session,token}=opened.body;
  const saved=await call(`/sessions/${session.ref}/responses`,'PUT',{baseVersion:0,requestId:'save-fixture',responses:{idea1:'Tốn tiền',idea2:'Hại môi trường',topicSentence:'Unnecessary purchases cause financial and environmental harm.'}},token);
  assert.equal(saved.status,200);
  assert.equal((await call(`/sessions/${session.ref}/checks`,'POST',{baseVersion:1,requestId:'check-fixture',section:'topic'},token)).status,202);
  const claim=await call('/internal/jobs/claim','POST',{});assert.equal(claim.status,200);assert.equal(claim.body.jobs.length,1);
  return {call,job:claim.body.jobs[0],session,token,db,store,service,processor,advance:ms=>{now+=ms;}};
}

test('R-FENCE · phản hồi JSON có dấu bao vẫn chấm đúng và giữ bản thô',async t=>{
  const h=await harness(t);
  const outputText='```json\n'+JSON.stringify({operation_key:h.job.operationKey,result:{resultStatus:'passed',feedback:'Câu chủ đề đã bao quát đủ hai ý.'}})+'\n```';
  const r=await h.call(`/internal/jobs/${h.job.jobRef}/response`,'POST',{...h.job,outputText,model:'fixture-model',httpStatus:200});
  assert.equal(r.status,200,'Backend phải tiếp nhận và đọc JSON có dấu bao, không bỏ lượt chấm.');
  const read=await h.call(`/sessions/${h.session.ref}`,'GET',undefined,h.token);
  assert.equal(read.body.session.steps.topic.status,'passed');assert.equal(read.body.session.steps.topic.history.length,1);
  const raw=await h.db.query('SELECT response_text FROM handout67.grading_attempt WHERE job_ref=$1',[h.job.jobRef]);
  assert.equal(raw.rows.length,1);assert.equal(raw.rows[0].response_text,outputText);
  assert.equal((await h.call(`/internal/jobs/${h.job.jobRef}/response`,'POST',{...h.job,outputText,model:'fixture-model',httpStatus:200})).status,200);
  assert.equal((await h.call(`/sessions/${h.session.ref}`,'GET',undefined,h.token)).body.session.steps.topic.history.length,1);
});

test('R-TIMEOUT · lỗi AI kết thúc hữu hạn và giữ bài để thử lại',async t=>{
  const h=await harness(t);h.advance(31*60000);
  // Không có n8n claim/callback sau khi sự cố: đọc lại vẫn phải giải phóng bước đã quá hạn.
  const read=await h.call(`/sessions/${h.session.ref}`,'GET',undefined,h.token);
  assert.equal(read.body.session.steps.topic.status,'technical_error','Pending không được phụ thuộc việc n8n còn hoạt động.');
  assert.equal(read.body.session.steps.topic.history.length,0);
  assert.equal(read.body.session.responses.topicSentence,'Unnecessary purchases cause financial and environmental harm.');
  const again=await h.call(`/sessions/${h.session.ref}/checks`,'POST',{baseVersion:1,requestId:'retry-fixture',section:'topic'},h.token);
  assert.equal(again.status,202);assert.notEqual(again.body.jobRef,h.job.jobRef);
});

test('R-NO-CAP · nhiều consumer cấp trên30 job riêng không trùng',async t=>{
  const students=Array.from({length:35},(_,i)=>({studentRef:'fixture-extra-'+i,displayName:'Học viên giả '+i}));
  const h=await harness(t,students);
  for(const student of students){
    const who=await h.service.open({activity:'lesson5',classRef:'fixture-c67',studentRef:student.studentRef});
    await h.service.save(who.session.ref,who.token,{baseVersion:0,requestId:'save-many',responses:{idea1:'Tốn tiền',idea2:'Hại môi trường',topicSentence:'Unnecessary purchases cause harm.'}});
    await h.service.check(who.session.ref,who.token,{baseVersion:1,requestId:'check-many',section:'topic'});
  }
  // 40 consumer tranh nhận35 job còn lại; không tự áp trần2/20/30 ở webapp.
  const batches=await Promise.all(Array.from({length:40},()=>h.service.claim()));
  assert.ok(batches.every(batch=>batch.length<=1));
  const jobs=[h.job,...batches.flat()];
  assert.equal(jobs.length,36);assert.equal(new Set(jobs.map(j=>j.jobRef)).size,36);
  assert.equal(new Set(jobs.map(j=>j.sessionRef)).size,36);
  assert.deepEqual(await h.service.claim(),[]);
  const rows=await h.db.query('SELECT count(*)::int AS total FROM handout67.grading_attempt');
  assert.equal(rows.rows[0].total,36);
});

const accepted=JSON.stringify({resultStatus:'passed',feedback:'Câu chủ đề đã bao quát đủ hai ý.'});
test('P-AUTH · gọi Cổng AI bằng đúng header sản phẩm đã xác minh',async()=>{
 const token='fixture-product-key'.padEnd(40,'k');
 const gateway=gatewayAdapter({gatewayUrl:'https://fixture.invalid/ai',gatewayToken:token},async(url,options)=>{
  assert.equal(options.headers['x-ai-gateway-key'],token);
  assert.equal(options.headers.Authorization,undefined);
  return new Response(JSON.stringify({gatewayMeta:{operation_key:'fixture-operation'},candidates:[{content:{parts:[{text:accepted}]}}]}),{status:200});
 });
 assert.equal((await gateway({operationKey:'fixture-operation',prompt:'Rubric fixture'})).httpStatus,200);
});
test('P-HTTP · execution chờ đúng attempt, replay không gọi AI hoặc nhân comment',async t=>{
  let calls=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const h=await harness(t,[],{callAI:async()=>{calls++;await gate;return {outputText:accepted,httpStatus:200};}});
  const path=`/internal/jobs/${h.job.jobRef}/process`;
  assert.equal((await h.call(path,'POST',h.job,'wrong-token')).status,401);
  const a=h.call(path,'POST',h.job),b=h.call(path,'POST',h.job);
  for(let i=0;i<100&&!calls;i++)await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(calls,1);
  assert.equal((await h.call(path,'POST',{...h.job,section:'a1'})).status,409);
  release();const results=await Promise.all([a,b]);assert.ok(results.every(r=>r.status===200&&r.body.status==='completed'));
  assert.equal((await h.call(path,'POST',h.job)).body.status,'completed');assert.equal(calls,1);
  assert.equal((await h.service.read(h.session.ref,h.token)).steps.topic.history.length,1);
});

test('P-RESTART · raw đã commit được dùng tiếp sau restart, không gọi AI lại',async t=>{
  let calls=0;const h=await harness(t,[],{callAI:async()=>{calls++;throw new Error('Không được gọi.');}});
  const job=await h.store.findJob(h.job.jobRef),attempt=job.attempts[0];
  await h.store.audit.capture(job,attempt,{outputText:accepted,httpStatus:200},Date.parse('2026-10-06T00:00:00Z'));
  const restarted=createProcessor({service:h.service,callAI:async()=>{calls++;throw new Error('Không được gọi.');}});
  assert.equal((await restarted.process(h.job)).status,'completed');assert.equal(calls,0);
  assert.equal((await h.service.read(h.session.ref,h.token)).steps.topic.history.length,1);
});

test('P-TRANSPORT · sai khóa Cổng AI giữ raw nhưng không mở bước',async t=>{
  const gateway=gatewayAdapter({gatewayUrl:'https://fixture.invalid/ai',gatewayToken:'fixture-token'.padEnd(40,'x')},async(url,options)=>{
    assert.equal(url,'https://fixture.invalid/ai');assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);assert.equal(body.model_id,'gemini-3.1-pro-preview');assert.equal(body.thinking_level,'high');
    assert.ok(body.operation_key.startsWith('handout-writing67:'));
    return new Response(JSON.stringify({gatewayMeta:{operation_key:'another-job'},candidates:[{content:{parts:[{thought:true,text:'Không giữ phần suy nghĩ.'},{text:accepted}]}}]}),{status:200});
  });
  const h=await harness(t,[],{callAI:gateway});
  const r=await h.call(`/internal/jobs/${h.job.jobRef}/process`,'POST',h.job);
  assert.equal(r.status,200);assert.equal(r.body.status,'queued');
  const session=await h.service.read(h.session.ref,h.token);assert.equal(session.steps.topic.status,'pending');assert.equal(session.steps.topic.history.length,0);
  const row=(await h.db.query('SELECT response_text,response_body,error_code FROM handout67.grading_attempt WHERE job_ref=$1',[h.job.jobRef])).rows[0];
  assert.equal(row.response_text,accepted);assert.equal(row.error_code,'AI_TRANSPORT_IDENTITY_MISMATCH');
  assert.ok(!JSON.stringify(row.response_body).includes('Không giữ phần suy nghĩ.'));
});

test('P-COMMIT · SQL gián đoạn retry ghi raw, không gọi AI thêm',async t=>{
  let calls=0,commits=0,waits=0;
  const h=await harness(t,[],{callAI:async()=>{calls++;return {outputText:accepted,httpStatus:200};},wait:async()=>{waits++;}});
  const receive=h.service.receive;h.service.receive=async input=>{commits++;if(commits<3)throw new Error('SQL_UNAVAILABLE_FIXTURE');return receive(input);};
  assert.equal((await h.processor.process(h.job)).status,'completed');assert.equal(calls,1);assert.equal(commits,3);assert.equal(waits,2);
  assert.equal((await h.service.read(h.session.ref,h.token)).steps.topic.history.length,1);
});

test('R-LATE · phản hồi lease cũ giữ evidence và không ghi đè lượt mới',async t=>{
  const h=await harness(t);h.advance(300000);const [next]=await h.service.claim();
  assert.notEqual(next.attemptRef,h.job.attemptRef);
  assert.equal((await h.service.receive({...h.job,outputText:accepted})).status,'late_response_saved');
  assert.equal((await h.service.read(h.session.ref,h.token)).steps.topic.history.length,0);
  assert.equal((await h.service.receive({...next,outputText:accepted})).status,'completed');
  const attempts=(await h.db.query('SELECT status,response_text FROM handout67.grading_attempt WHERE job_ref=$1 ORDER BY attempt_index',[h.job.jobRef])).rows;
  assert.equal(attempts[0].status,'timed_out');assert.equal(attempts[0].response_text,accepted);
  assert.equal(attempts[1].status,'completed');
  assert.equal((await h.service.read(h.session.ref,h.token)).steps.topic.history.length,1);
});

test('R-DEADLINE · kết quả quá hạn giữ raw và không mở bước trước sweep',async t=>{
  const h=await harness(t);h.advance(29*60000+59000);const [next]=await h.service.claim();h.advance(2000);
  const result=await h.service.receive({...next,outputText:accepted});
  assert.equal(result.status,'failed');assert.equal((await h.store.read(h.session.ref)).steps.topic.history.length,0);
  assert.equal((await h.db.query('SELECT response_text FROM handout67.grading_attempt WHERE attempt_ref=$1',[next.attemptRef])).rows[0].response_text,accepted);
});
test('P-DEADLINE · execution quá hạn không phát thêm yêu cầu AI',async t=>{
  let calls=0;const h=await harness(t,[],{callAI:async()=>{calls++;return {outputText:accepted};}});
  h.advance(29*60000+59000);const [next]=await h.service.claim();h.advance(2000);
  assert.equal((await h.processor.process(next)).status,'failed');assert.equal(calls,0);
});
test('P-MODEL · ghi model thực hoặc chưa biết, không suy từ model yêu cầu',async()=>{
  const response=metadata=>new Response(JSON.stringify({...metadata,candidates:[{content:{parts:[{text:accepted}]}}]}),{status:200});
  const job={operationKey:'same',prompt:'fixture'};
  const adapter=body=>gatewayAdapter({gatewayUrl:'https://fixture.invalid/ai',gatewayToken:'t'.repeat(40)},async()=>response(body));
  assert.equal((await adapter({gatewayMeta:{operation_key:'same'}})(job)).model,null);
  assert.equal((await adapter({gatewayMeta:{operation_key:'same',model:'actual-fallback-model'}})(job)).model,'actual-fallback-model');
});
