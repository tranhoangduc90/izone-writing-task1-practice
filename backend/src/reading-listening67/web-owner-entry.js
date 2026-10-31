// A document identifies an assignment context, never a credential or teacher grant.
// The existing registry was verified against Classroom; APIs still check membership.
import {WebGradingError} from './web-grader.js';
const fail=code=>{throw new WebGradingError(code,403);};
export const READING_ENTRY_HEADER='x-reading-homework-document';
export function createReading67OwnerEntry({db,identity,metadata,policy}){
 if(!policy)return null;
 if(metadata.code!=='67-reading-homework-butterflies-britain-tfng'||policy.classId!=='1293'||policy.classCode!=='IC2304'||policy.courseId!=='826336470852'||policy.courseWorkId!=='896541293906')throw Error('OWNER_ENTRY_PILOT_SCOPE_INVALID');
 const matches=(s,t)=>s.courseId===policy.classId&&s.code===metadata.code&&s.version===metadata.version&&t?.classId===s.courseId&&t.studentRef===s.ownerId&&t.code===s.code&&t.version===s.version&&t.courseId===policy.courseId&&t.courseWorkId===policy.courseWorkId;
 async function binding(documentId){
  if(typeof documentId!=='string'||!/^[A-Za-z0-9_-]{20,200}$/.test(documentId))fail('HOMEWORK_ENTRY_NOT_FOUND');
  const rows=(await db.query('SELECT owner_id,course_id,assignment_code,content_version,target FROM reading_listening67.web_homework_binding WHERE assignment_code=$1 AND content_version=$2 AND course_id=$3 AND target->>\'documentId\'=$4',[metadata.code,metadata.version,policy.classId,documentId])).rows;
  if(rows.length!==1)fail('HOMEWORK_ENTRY_NOT_FOUND');
  const b=rows[0],scope={ownerId:b.owner_id,courseId:b.course_id,code:b.assignment_code,version:b.content_version};
  if(!matches(scope,b.target)||b.target.documentId!==documentId||!b.target.submissionId||!b.target.tabId)fail('HOMEWORK_ENTRY_NOT_FOUND');
  return {scope,target:b.target};
 }
 return {publicPolicy:{classId:policy.classId,classCode:policy.classCode},
  url(base,scope,target){if(!matches(scope,target))return base;const u=new URL(base);u.searchParams.set('mode','student');u.searchParams.set('class',policy.classCode);u.searchParams.set('documentId',target.documentId);return u.href;},
  async resolve(documentId){const {scope}=await binding(documentId);const p=await identity.member(scope.courseId,scope.ownerId);return {documentId,classId:scope.courseId,studentRef:scope.ownerId,name:p.name,classCode:p.className,code:metadata.code,version:metadata.version};},
  async assert(documentId,person){const {scope}=await binding(documentId);if(person.ownerId!==scope.ownerId||person.courseId!==scope.courseId)fail('HOMEWORK_ENTRY_OWNER_MISMATCH');}
 };
}
