import {randomUUID} from 'node:crypto';

// Optional, read-only diagnostics. The immutable attempt supplies the identity,
// including the old run when the learner has already reset or edited a draft.
// A native commit is never delayed by the logger or its network transport.
export function createHomeworkWorkerJournal({db,store,journal,content,expectedCount,clock=Date.now}){
 if(!journal?.worker)return{store,onStart:null};
 const entries=new WeakMap();
 const label=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(value)?value:undefined;
 const hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?value:undefined;
 const callId=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)?value.toLowerCase():undefined;
 const count=value=>Number.isSafeInteger(value)&&value>=0&&value<=10000?value:undefined;
 const code=value=>typeof value==='string'&&/^[A-Z][A-Z0-9_]{0,79}$/.test(value)?value:undefined;
 const errorCode=error=>code(error?.code)||'GRADING_VALIDATION_FAILED';
 const compact=value=>Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined));
 function entry(job){
  let value=entries.get(job);
  if(value)return ['jobId','attemptId','ownerId','leaseToken'].every(key=>value.ids[key]===job[key])?value:null;
  const ids={jobId:job.jobId,attemptId:job.attemptId,ownerId:job.ownerId,leaseToken:job.leaseToken};
  value={ids,started:performance.now(),inputHash:hash(job.inputHash),graderHash:hash(job.graderHash)};
  value.scope=Promise.resolve().then(async()=>{
   const result=await db.query(`SELECT a.owner_id,a.course_id,a.assignment_code,a.content_version,a.run_no
    FROM reading_listening67.web_attempt a JOIN reading_listening67.web_job j ON j.attempt_id=a.id
    WHERE j.id=$1 AND a.id=$2 AND a.owner_id=$3 AND j.lease_token=$4`,[ids.jobId,ids.attemptId,ids.ownerId,ids.leaseToken]);
   if(result.rows.length!==1)return null;const a=result.rows[0];
   if(content&&(a.assignment_code!==content.code||String(a.content_version)!==String(content.version)))return null;
   return{ownerId:a.owner_id,courseId:a.course_id,code:a.assignment_code,version:a.content_version,runNo:a.run_no};
  }).catch(()=>null);
  entries.set(job,value);return value;
 }
 function emit(value,fields){
  try{
   const receipt={receiptId:randomUUID(),jobId:value.ids.jobId,attemptId:value.ids.attemptId,observedAt:new Date(clock()).toISOString(),
    data:compact({expectedCount:count(expectedCount),inputHash:value.inputHash,graderHash:value.graderHash,...fields})};
   setImmediate(()=>{void value.scope.then(scope=>scope?journal.worker(scope,receipt):undefined).catch(()=>{});});
  }catch{}
 }
 const observe=fn=>{try{return fn();}catch{return null;}};
 const wrapped={...store,
  async recordProvider(job,response){
   const value=observe(()=>entry(job)),result=await store.recordProvider(job,response);
   if(value)emit(value,{phase:'provider_received',status:'received'});return result;
  },
  async finish(job,result){
   const value=observe(()=>entry(job)),receivedCount=Array.isArray(result?.grading?.target_results)?result.grading.target_results.length:undefined;
   const native=await store.finish(job,result);
   if(value)emit(value,{phase:'completed',status:'done',receivedCount:count(receivedCount),durationMs:Math.max(0,Math.round(performance.now()-value.started))});return native;
  },
  async fail(job,error){
   const value=observe(()=>entry(job)),code=errorCode(error),native=await store.fail(job,error);
   if(value)emit(value,{phase:'failed',status:['AI_OUTCOME_UNKNOWN','AI_VALIDATION_NEEDS_REVIEW'].includes(code)?'needs_review':'failed',errorCode:code});return native;
  },
 };
 if(store.validation)wrapped.validation={...store.validation,
  async round(job,event){
   const value=observe(()=>entry(job)),data=compact({phase:'round',status:['calling','received','unknown','failed'].includes(event.status)?event.status:undefined,
    validationPhase:label(event.phase),validationVersion:label(event.validationVersion),roundNo:count(event.round),errorCode:code(event.errorCode),callId:callId(event.callId)});
   const result=await store.validation.round(job,event);if(value)emit(value,data);return result;
  },
  async checkpoint(job,state){
   const value=observe(()=>entry(job)),data=compact({phase:'checkpoint',validationPhase:label(state.phase),validationVersion:label(state.version),roundNo:count(state.round),callId:callId(state.lastCallId)});
   const result=await store.validation.checkpoint(job,state);if(value)emit(value,data);return result;
  },
  async defer(job,error){
   const value=observe(()=>entry(job)),code=errorCode(error),result=await store.validation.defer(job,error);
   if(value)emit(value,{phase:'deferred',status:'queued',errorCode:code});return result;
  },
 };
 return{store:wrapped,onStart(job){observe(()=>{const value=entry(job);emit(value,{phase:'started'});});}};
}
