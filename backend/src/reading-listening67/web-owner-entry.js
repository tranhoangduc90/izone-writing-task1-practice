// A document identifies an assignment context, never a credential or teacher grant.
// The existing registry was verified against Classroom; APIs still check membership.
import {WebGradingError} from './web-grader.js';
const fail=code=>{throw new WebGradingError(code,403);};
export const READING_ENTRY_HEADER='x-reading-homework-document';
export function createReading67OwnerEntry({db,identity,ownerSource,metadata,policy}){
 if(!policy)return null;
 // Keep the deployed single-class policy compatible while rolling out a class list.
 const classes=policy.classes||[policy];
 if(!classes.length||new Set(classes.map(c=>c.classId)).size!==classes.length||classes.some(c=>!/^\d+$/.test(c.classId)||typeof c.classCode!=='string'||!c.classCode.trim()||typeof c.courseId!=='string'||!c.courseId))throw Error('OWNER_ENTRY_SCOPE_INVALID');
 const byClass=new Map(classes.map(c=>[c.classId,c]));
 const matches=(s,t)=>{const c=byClass.get(s.courseId);return !!c&&s.code===metadata.code&&s.version===metadata.version&&t?.classId===s.courseId&&t.studentRef===s.ownerId&&t.code===s.code&&t.version===s.version&&t.courseId===c.courseId&&(!c.courseWorkId||t.courseWorkId===c.courseWorkId);};
 async function binding(documentId){
  if(typeof documentId!=='string'||!/^[A-Za-z0-9_-]{20,200}$/.test(documentId))fail('HOMEWORK_ENTRY_NOT_FOUND');
  const rows=(await db.query('SELECT owner_id,course_id,assignment_code,content_version,target FROM reading_listening67.web_homework_binding WHERE assignment_code=$1 AND content_version=$2 AND target->>\'documentId\'=$3',[metadata.code,metadata.version,documentId])).rows;
  if(rows.length!==1)fail('HOMEWORK_ENTRY_NOT_FOUND');
  const b=rows[0],scope={ownerId:b.owner_id,courseId:b.course_id,code:b.assignment_code,version:b.content_version};
  if(!matches(scope,b.target)||b.target.documentId!==documentId||!b.target.courseWorkId||!b.target.submissionId||!b.target.tabId)fail('HOMEWORK_ENTRY_NOT_FOUND');
  return {scope,target:b.target};
 }
 async function current(scope,target){
  const p=await identity.member(scope.courseId,scope.ownerId);
  if(p.className!==byClass.get(scope.courseId).classCode)fail('HOMEWORK_ENTRY_NOT_FOUND');
  if(ownerSource){const source=await ownerSource.member(scope.courseId,scope.ownerId);if(source.courseId!==target.courseId||source.googleUserId!==target.googleUserId)fail('HOMEWORK_ENTRY_NOT_FOUND');}
  return p;
 }
 return {publicPolicy:{classes:classes.map(({classId,classCode})=>({classId,classCode}))},
  url(base,scope,target){if(!matches(scope,target))return base;const u=new URL(base);u.searchParams.set('mode','student');u.searchParams.set('class',byClass.get(scope.courseId).classCode);u.searchParams.set('documentId',target.documentId);return u.href;},
  async resolve(documentId){const {scope,target}=await binding(documentId);const p=await current(scope,target);return {documentId,classId:scope.courseId,studentRef:scope.ownerId,name:p.name,classCode:p.className,code:metadata.code,version:metadata.version};},
  async assert(documentId,person){const {scope,target}=await binding(documentId);if(person.ownerId!==scope.ownerId||person.courseId!==scope.courseId)fail('HOMEWORK_ENTRY_OWNER_MISMATCH');await current(scope,target);}
 };
}
