import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

// One transport per Homework process, shared by every native lesson.
export async function startHomeworkJournal({productId,origins,env=process.env}){
 if(env.EXAM_JOURNAL_ENABLED!=='1')return null;
 try{
  const {startLearningJournalRuntime}=await import(pathToFileURL(resolve(
   env.EXAM_JOURNAL_LIBRARY_ROOT||'/opt/exam-journal','adapters/learning-runtime.mjs')).href);
  return await startLearningJournalRuntime({productId,env,allowedOrigins:origins,
   onHealth:value=>console.error(JSON.stringify(value))});
 }catch{console.error(JSON.stringify({type:'learning_journal_health',status:'degraded',errorCode:'LEARNING_JOURNAL_START_FAILED'}));return null;}
}
export async function stopHomeworkJournal(runtime){
 try{return await runtime?.close();}
 catch{console.error(JSON.stringify({type:'learning_journal_health',status:'degraded',errorCode:'LEARNING_JOURNAL_SHUTDOWN_UNKNOWN'}));return{status:'shutdown_unknown'};}
}
