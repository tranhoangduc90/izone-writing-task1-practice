import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {createNativeDispatch} from '../src/native-dispatch.mjs';

const productId='handout-writing67';
function makeJob(kind) {
  const jobRef=randomUUID();
  const grade=kind==='grade';
  return {productId,kind,jobRef,sessionRef:randomUUID(),leaseToken:randomUUID(),attemptRef:randomUUID(),
    snapshotHash:'fixture',prompt:'fixture',promptVersion:'qa-v1',operationKey:productId+':'+jobRef+':qa-v1',
    section:grade?'outline':null,bodyIndex:grade?0:1,ideaIndex:0,
    snapshot:{workflowMode:'whole-chain-v1',handoutMode:'two-bodies-v1',preparationMode:'ideas-first-v1'}};
}
const deferred=()=>{let resolve;const promise=new Promise(c=>{resolve=c;});return {promise,resolve};};

test('drains only one job at a time and verifies the committed job after an ACK loss',async()=>{
  const grade=makeJob('grade'), vocab=makeJob('vocab');
  const pending=[grade,vocab];
  const rows=new Map();
  const completed=deferred();
  const entered=deferred();
  const release=deferred();
  const receipts=[];
  let calls=0;
  const service={
    claim:async()=>pending.length?[pending.shift()]:[],
    job:async id=>rows.get(id),
  };
  const processor={async process(job){
    calls++;
    if(job.kind==='grade') {entered.resolve();await release.promise;}
    const row={productId,jobRef:job.jobRef,status:'completed',resultHash:job.kind,tries:1};
    rows.set(job.jobRef,row);
    if(job.kind==='grade') throw Error('commit ACK lost');
    return {jobRef:job.jobRef,status:'completed',resultHash:row.resultHash};
  }};
  const native=createNativeDispatch({
    service,processor,hasWork:async()=>pending.length>0,
    onReceipt(receipt){receipts.push(receipt);if(receipts.length===2) completed.resolve();},
    onError:error=>assert.fail(error)
  });
  try {
    native.request();
    await entered.promise;
    native.request();
    native.request();
    assert.equal(calls,1);
    release.resolve();
    await completed.promise;
    assert.equal(calls,2);
    assert.deepEqual(receipts.map(row=>row.jobRef),[grade.jobRef,vocab.jobRef]);
    assert.ok(receipts.every(row=>row.status==='result_saved'&&row.tries===1));
  } finally { await native.close(); }
});

test('never processes an unexpected product or more than one lease',async()=>{
  for(const payload of [[{...makeJob('grade'),productId:'wrong'}],[makeJob('grade'),makeJob('vocab')],[{...makeJob('grade'),bodyIndex:'0'}]]) {
    const failure=deferred();
    const native=createNativeDispatch({
      service:{claim:async()=>payload},processor:{process:async()=>assert.fail('invalid job processed')},
      hasWork:async()=>true,onError:failure.resolve
    });
    try {
      await native.tick();
      assert.match((await failure.promise).message,/HANDOUT67_CLAIM_(IDENTITY|COUNT|TARGET)_INVALID/);
    } finally { await native.close(); }
  }
});

test('legacy signal is pinned to its own bearer and n8n cannot claim in native mode',async t=>{
  const {createApi}=await import('../src/http.mjs');
  let wakes=0;
  const internal='internal-fixture'.repeat(3), wake='wakeup-fixture'.repeat(3);
  const server=createApi({
    service:{claim:async()=>assert.fail('legacy called claim while native active')},
    origins:['http://127.0.0.1'],internalSecret:internal,legacyWakeSecret:wake,
    nativeWake:()=>{wakes++;}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const base='http://127.0.0.1:'+server.address().port+'/api/handout67/v1/internal/';
  const post=(path,bearer,body,extra={})=>fetch(base+path,{method:'POST',headers:{
    Authorization:'Bearer '+bearer,'Content-Type':'application/json',...extra},body:JSON.stringify(body)});
  const scope={productId:'handout-writing67'};
  assert.equal((await post('native-dispatch/wake',internal,scope)).status,401);
  assert.equal((await post('native-dispatch/wake',wake,scope,{Origin:'http://127.0.0.1'})).status,401);
  assert.equal((await post('native-dispatch/wake',wake,{productId:'wrong'})).status,422);
  assert.equal((await post('native-dispatch/wake',wake,scope)).status,202);
  assert.equal(wakes,1);
  const r=await post('jobs/claim',internal,{});
  assert.deepEqual(await r.json(),{ok:true,jobs:[]});
});

test('holds the observed production peak of two leases under a ten-job burst',async()=>{
  const backlog=Array.from({length:10},(_,i)=>makeJob(i%2===0?'grade':'vocab'));
  const rows=new Map(),results=[];
  const done=deferred();
  let active=0,peak=0;
  const worker=createNativeDispatch({
    capacity:2,service:{claim:async()=>backlog.length?[backlog.shift()]:[],job:id=>rows.get(id)},
    processor:{async process(job){
      peak=Math.max(peak,++active);
      await new Promise(resolve=>setTimeout(resolve,2));
      active--;
      const row={productId,jobRef:job.jobRef,status:'completed',resultHash:'fixture-'+job.jobRef,tries:1};
      rows.set(job.jobRef,row);
      return row;
    }},
    hasWork:async()=>backlog.length>0,
    onReceipt(row){results.push(row);if(results.length===10)done.resolve()},
    onError:error=>assert.fail(error)
  });
  try{
    worker.request();
    await done.promise;
    assert.equal(peak,2);
    assert.equal(new Set(results.map(row=>row.jobRef)).size,10);
  }finally{await worker.close();}
});
