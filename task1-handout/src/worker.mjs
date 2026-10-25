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
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
 const config=loadConfig(),pool=createDatabasePool(config),service=createService({pool,pepper:config.pepper});
 let stop=false;process.on('SIGTERM',()=>{stop=true;});process.on('SIGINT',()=>{stop=true;});
 while(!stop){
  try{await service.recoverJobs();const outcomes=await processBatch({service,aiUrl:config.aiUrl});console.log(JSON.stringify({at:new Date().toISOString(),productId:'sw-task1',outcome:outcomes.length?'processed':'idle',jobs:outcomes}));}
  catch(error){console.error(JSON.stringify({at:new Date().toISOString(),productId:'sw-task1',outcome:'unknown',errorType:error.name}));}
  if(!stop)await delay(5000);
 }
 await pool.end();
}
