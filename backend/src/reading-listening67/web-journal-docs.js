import {createHash} from 'node:crypto';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function receiptId(jobId,leaseId,phase){
 const bytes=createHash('sha256').update(JSON.stringify([jobId,phase==='queued'?null:leaseId,phase])).digest();
 bytes[6]=(bytes[6]&15)|128;bytes[8]=(bytes[8]&63)|128;const hex=bytes.subarray(0,16).toString('hex');
 return [hex.slice(0,8),hex.slice(8,12),hex.slice(12,16),hex.slice(16,20),hex.slice(20)].join('-');
}

// Read only the native job/binding metadata. Never retain its text/link payload.
export function createHomeworkDocsJournal({journal,metadata,clock=Date.now}){
 const enabled=typeof journal?.docs==='function';
 function capture(scope,job){
  if(!enabled||!scope||scope.code!==metadata.code||scope.version!==metadata.version||!uuid.test(job?.id||''))return null;
  if(!['cta','status'].includes(job.kind)||!Number.isSafeInteger(job.sequence)||job.sequence<0)return null;
  const runNo=job.kind==='cta'?0:job.payload?.runNo;
  if(!Number.isSafeInteger(runNo)||runNo<0||job.kind==='status'&&runNo<1)return null;
  const binding={ownerId:scope.ownerId,courseId:scope.courseId,code:scope.code,version:scope.version,runNo};
  const jobId=job.id,leaseId=job.leaseId,jobKind=job.kind,queueSequence=job.sequence,jobAttempt=job.attempts,
   attemptId=uuid.test(job.payload?.attemptId||'')?job.payload.attemptId:undefined;
  const created=Date.parse(job.created_at),started=clock();let reads=0,writes=0,targetHash,writePlan={};
  const emit=(phase,extra={})=>{
   try{
    if(phase==='queued'&&!Number.isFinite(created))return;
    if(phase!=='queued'&&(!uuid.test(leaseId||'')||!Number.isSafeInteger(jobAttempt)||jobAttempt<1))return;
    const observedAt=new Date(clock()).toISOString();
    const receipt={receiptId:receiptId(jobId,leaseId,phase),jobId,...(attemptId?{attemptId}:{}),
     observedAt:phase==='queued'&&Number.isFinite(created)?new Date(created).toISOString():observedAt,
     data:{phase,jobKind,queueSequence,jobAttempt:phase==='queued'?0:jobAttempt,
      readCalls:reads,writeCalls:writes,...(targetHash?{targetHash}:{}),...writePlan,
      ...(phase==='queued'?{}:{queueAgeMs:Number.isFinite(created)?Math.max(0,Math.round(clock()-created)):0,
       durationMs:Math.max(0,Math.round(clock()-started)),observedAt}),...extra}};
    setImmediate(()=>{try{const pending=journal.docs(binding,receipt);pending?.catch?.(()=>{});}catch{}});
   }catch{}
  };
  return {emit,read(){reads++;},write(plan){
   writes++;const requests=Array.isArray(plan?.requests)?plan.requests:[],indices=requests.flatMap(r=>[
    r.insertText?.location?.index,r.deleteContentRange?.range?.startIndex,r.deleteContentRange?.range?.endIndex,
    r.updateTextStyle?.range?.startIndex,r.updateTextStyle?.range?.endIndex,
   ]).filter(v=>Number.isSafeInteger(v)&&v>=0);
   writePlan={writeRequestCount:requests.length,...(indices.length?{rangeStart:Math.min(...indices),rangeEnd:Math.max(...indices)}:{})};
   emit('write_attempt');},
   resolved(target){try{targetHash=createHash('sha256').update(JSON.stringify([target.documentId,target.tabId])).digest('hex');emit('target_resolved');}catch{}},
   finish(phase,errorCode,retryDelaySeconds){emit(phase,{
    ...(typeof errorCode==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(errorCode)?{errorCode}:{}),
    ...(retryDelaySeconds===undefined?{}:{retryDelaySeconds}),
   });}};
 }
 return {enabled,queued(scope,job){try{capture(scope,job)?.emit('queued');}catch{}},
  start(scope,job){try{const result=capture(scope,job);result?.emit('queued');result?.emit('started');return result;}catch{return null;}}};
}
