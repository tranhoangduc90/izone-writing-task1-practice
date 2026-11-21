const PRODUCT='handout-writing67';
const ID=/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

function targetValid(job) {
  const {kind,section,bodyIndex,ideaIndex}=job;
  const mode=job.snapshot?.workflowMode||'guided-bax-v1';
  const multi=job.snapshot?.handoutMode==='two-bodies-v1';
  if(multi&&mode==='whole-chain-v1') {
    if(kind==='vocab') return section===null&&ideaIndex===0&&[1,2].includes(bodyIndex);
    if(job.snapshot?.preparationMode==='ideas-first-v1'&&section==='outline') return bodyIndex===0&&ideaIndex===0;
    const matched=/^body([12])_(topic|si1|si2)$/.exec(section||'');
    return !!matched&&bodyIndex===Number(matched[1])&&ideaIndex===(matched[2]==='topic'?null:Number(matched[2].slice(-1)));
  }
  if(multi||bodyIndex!=null) return false;
  if(mode==='guided-bax-v1') {
    return kind==='grade'?['topic','a1','x1','b1','a2','x2','b2'].includes(section):[1,2].includes(ideaIndex);
  }
  if(mode!=='whole-chain-v1') return false;
  if(kind==='vocab') return section===null&&ideaIndex===0;
  return (section==='topic'&&ideaIndex===null)||(section==='si1'&&ideaIndex===1)||(section==='si2'&&ideaIndex===2);
}

function claimedJob(value) {
  if(!Array.isArray(value)||value.length>1) throw Error('HANDOUT67_CLAIM_COUNT_INVALID');
  if(!value.length) return null;
  const [job]=value;
  if(job.productId!==PRODUCT||
      ![job.jobRef,job.sessionRef,job.leaseToken,job.attemptRef].every(value=>typeof value==='string'&&ID.test(value))||
      ![job.snapshotHash,job.promptVersion,job.prompt].every(value=>typeof value==='string'&&value)||
      !['grade','vocab'].includes(job.kind)||
      job.operationKey!==PRODUCT+':'+job.jobRef+':'+job.promptVersion) throw Error('HANDOUT67_CLAIM_IDENTITY_INVALID');
  if(!targetValid(job)) throw Error('HANDOUT67_CLAIM_TARGET_INVALID');
  return job;
}

function receiptOutcome(read,receipt) {
  const supportedRead=['completed','queued','failed','leased','superseded'];
  if(!supportedRead.includes(read.status)) throw Error('HANDOUT67_NATIVE_READBACK_STATE_INVALID');
  const supportedReceipts=['completed','queued','failed','late_response_saved','superseded'];
  if(!supportedReceipts.includes(receipt.status)) throw Error('HANDOUT67_NATIVE_RECEIPT_STATE_INVALID');
  if(read.status==='superseded'&&receipt.status!=='completed') return 'previous_attempt_superseded';
  if(receipt.status==='completed'&&read.status==='completed'&&read.resultHash&&read.resultHash===receipt.resultHash) return 'result_saved';
  if(receipt.status==='failed'&&read.status==='failed') return 'technical_error';
  if(receipt.status==='queued') return 'retry_scheduled';
  if(receipt.status==='late_response_saved') return 'late_response_saved';
  throw Error('HANDOUT67_NATIVE_READBACK_MISMATCH');
}

export function createNativeDispatch({service,processor,hasWork,capacity=1,intervalMs=30_000,onReceipt=()=>{},onError=()=>{}}) {
  if(!Number.isSafeInteger(capacity)||capacity<1) throw Error('HANDOUT67_NATIVE_CAPACITY_INVALID');
  const inflight=new Set();
  let pumping=null;
  let requested=false;
  let closed=false;

  async function run(job) {
    let phase='process';
    const started=performance.now();
    try {
      let outcome;
      try {
        outcome=await processor.process(job);
      } catch (error) {
        // A successful commit may have lost its reply. Read the leased job before retrying.
        phase='readback';
        const row=await service.job(job.jobRef);
        if(row?.productId!==PRODUCT||row?.jobRef!==job.jobRef||row.status!=='completed'||!row.resultHash) {
          phase='process';
          throw new Error('HANDOUT67_NATIVE_PROCESS_UNVERIFIED',{cause:error});
        }
        outcome={jobRef:job.jobRef,status:'completed',resultHash:row.resultHash};
      }
      phase='readback';
      const row=await service.job(job.jobRef);
      if(outcome?.jobRef!==job.jobRef||row?.jobRef!==job.jobRef||row?.productId!==PRODUCT) {
        throw Error('HANDOUT67_NATIVE_RECEIPT_IDENTITY_INVALID');
      }
      const disposition=receiptOutcome(row,outcome);
      onReceipt({jobRef:job.jobRef,kind:job.kind,status:disposition,resultHash:row.resultHash,tries:row.tries});
    } catch(error) {
      onError(error,{phase,kind:job.kind,durationMs:performance.now()-started});
    }
  }

  async function fill() {
    while(!closed&&inflight.size<capacity) {
      const job=claimedJob(await service.claim());
      if(!job) return;
      const pending=run(job).finally(()=>{
        inflight.delete(pending);
        request();
      });
      inflight.add(pending);
    }
  }

  function request() {
    if(closed) return;
    requested=true;
    if(pumping) return;
    pumping=Promise.resolve().then(async()=>{
      while(requested&&!closed) {
        requested=false;
        await fill();
      }
    }).catch(error=>onError(error,{phase:'claim'})).finally(()=>{
      pumping=null;
      if(requested&&!closed) request();
    });
  }

  async function tick() {
    if(closed||pumping||inflight.size>=capacity) return;
    const started=performance.now();
    try {
      if(await hasWork()) request();
    } catch(error) { onError(error,{phase:'hasWork',durationMs:performance.now()-started}); }
  }

  const timer=setInterval(()=>void tick(),intervalMs);
  timer.unref();
  return {
    request,tick,
    async close(){
      closed=true;
      clearInterval(timer);
      await pumping;
      await Promise.allSettled([...inflight]);
    },
  };
}
