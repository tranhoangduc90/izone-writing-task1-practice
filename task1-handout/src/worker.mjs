import {setTimeout as delay} from 'node:timers/promises';
import {pathToFileURL} from 'node:url';
import {createDatabasePool} from '../vendor/db.js';
import {loadConfig} from './config.mjs';
import {createService} from './service.mjs';
import {gradeJob} from './grading.mjs';
export async function processBatch({service,aiUrl,call,workerId='sw-task1-worker'}){
 const jobs=await service.claimJobs({workerId,maxJobs:2,leaseSeconds:420,workerPool:'task1'});
 return Promise.all(jobs.map(async job=>{
  try{
   const result=await gradeJob({job,context:job.gradingContext,aiUrl,call});
   await service.completeJob({jobRef:job.jobRef,leaseToken:job.leaseToken,...result});
   return {jobRef:job.jobRef,outcome:'completed',resultStatus:result.resultStatus};
  }catch(error){
   // Never turn a timeout/invalid answer into an academic failure. No automatic AI retry.
   let outcome='technical_error';
   try{await service.failJob({jobRef:job.jobRef,leaseToken:job.leaseToken,errorCode:'TASK1_AI_TECHNICAL_ERROR',retryable:true});}catch{outcome='unknown';}
   return {jobRef:job.jobRef,outcome,errorType:error.name};
  }
 }));
}
export async function runWorker({service,aiUrl,signal,pause=delay,logger=console}){
 const log=(level,fields)=>logger[level](JSON.stringify({at:new Date().toISOString(),productId:'sw-task1',...fields}));
 async function recover(){
  try{
   const jobs=await service.recoverJobs();
   if(jobs.length)log('log',{outcome:'recovered',count:jobs.length});
  }catch(error){log('error',{outcome:'unknown',stage:'recover',errorType:error.name});}
 }
 async function discover(){
  try{
   const jobs=await processBatch({service,aiUrl});
   log('log',{outcome:jobs.length?'processed':'idle',jobs});
  }catch(error){log('error',{outcome:'unknown',stage:'claim',errorType:error.name});}
 }
 async function repeat(interval,task){
  while(!signal.aborted){
   try{await pause(interval,undefined,{signal});}
   catch(error){if(signal.aborted&&error.name==='AbortError')return;throw error;}
   if(!signal.aborted)await task();
  }
 }
 // Recover expired leases before the first claim, and continue recovery even during a long AI call.
 await recover();
 await Promise.all([repeat(30000,recover),(async()=>{
  if(!signal.aborted)await discover();
  await repeat(5000,discover);
 })()]);
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const config=loadConfig(),pool=createDatabasePool(config),service=createService({pool,pepper:config.pepper});
 const stop=new AbortController();
 process.on('SIGTERM',()=>stop.abort());process.on('SIGINT',()=>stop.abort());
 try{await runWorker({service,aiUrl:config.aiUrl,signal:stop.signal});}
 finally{await pool.end();}
}
