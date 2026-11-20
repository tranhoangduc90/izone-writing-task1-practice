import { executeDocsWrite } from '../google-docs-write/execute.js';
import { WebGradingError } from './web-grader.js';
import { guardReading67HomeworkDocs } from './web-homework-code-guard.js';

const lease = "id=$1 AND lease_id=$2 AND status='processing' AND lease_until>now()";
const rowOrLost = result => {
 const row=result.rows[0];
 if(!row)throw new WebGradingError('DOC_LEASE_LOST',409);
 return row;
};

export function createHomeworkSharedStatusWriter({db,product,accounts,withDocumentLock,managedCodes,log}) {
 const guarded=Object.fromEntries(Object.entries(accounts).map(([role,account])=>
  [role,guardReading67HomeworkDocs(account,managedCodes)]));
 return async ({job,target,binding,planWrite,acknowledge,capture})=>{
  const key=[job.id,job.leaseId];
  const {documentId,tabId}=target;
  const readLease=async()=>rowOrLost(await db.query(
   'SELECT shared_docs_attempt FROM reading_listening67.web_homework_job WHERE '+lease,key));
  function assertTarget(){
   if(job.kind!=='status'||binding.document_id!==documentId||binding.tab_id!==tabId)
    throw new WebGradingError('DOC_IDENTITY_MISMATCH',409);
  }
  const traced=capture?Object.fromEntries(Object.entries(guarded).map(([role,account])=>[role,{...account,
   read(...args){capture.read();return account.read(...args);},
   async write(id,plan,count){capture.write(plan);const response=await account.write(id,plan,count);capture.emit('write_received');return response;},
  }])):guarded;
  const result=await executeDocsWrite({product,eventId:job.id,resultVersion:job.sequence,binding:{documentId,tabId}},{
   accounts:traced,withDocumentLock,log,
   verifySource:assertTarget,
   async loadCurrentProjection(){
    const {shared_docs_attempt:attempt}=await readLease();
    if(attempt&&(attempt.documentId!==documentId||attempt.tabId!==tabId))throw new WebGradingError('DOC_TARGET_CHANGED',409);
    return {reconciliation:attempt};
   },
   assertWriter:assertTarget,
   plan:doc=>planWrite(doc,binding,job),
   verify:doc=>planWrite(doc,binding,job).verified,
   async recordAttempt({accountRole,revisionId}){
    // Persisting the attempt also fences the lease immediately before Google.
    rowOrLost(await db.query('UPDATE reading_listening67.web_homework_job SET shared_docs_attempt=$3::jsonb WHERE '+lease+
     ' AND shared_docs_attempt IS NULL RETURNING id',[...key,JSON.stringify({accountRole,revisionId,documentId,tabId})]));
   },
   async recordRejection(){
    rowOrLost(await db.query('UPDATE reading_listening67.web_homework_job SET shared_docs_attempt=NULL WHERE '+lease+' RETURNING id',key));
   },
   recordVerified:()=>acknowledge(true),
  });
  if(!result.readback)throw new WebGradingError('DOC_NEEDS_RECONCILIATION',503);
  return result;
 };
}
