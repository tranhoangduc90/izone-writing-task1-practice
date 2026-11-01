// A document identifies an assignment context, never a credential or teacher grant.
// The existing registry was verified against Classroom; APIs still check membership.
import {WebGradingError} from './web-grader.js';
const fail=code=>{throw new WebGradingError(code,403);};
export const READING_ENTRY_HEADER='x-reading-homework-document';
export function createReading67OwnerEntry({db,identity,ownerSource,metadata,policy}){
 if(!policy)return null;
 // Keep the deployed single-class policy compatible while rolling out a class list.
 const classes=policy.classes||[policy];
 const currentCourse=policy.verifyCourseFromOwnerSource===true;
 if(currentCourse&&!ownerSource)throw Error('OWNER_ENTRY_SOURCE_REQUIRED');
 if(!classes.length||new Set(classes.map(c=>c.classId)).size!==classes.length||classes.some(c=>!/^\d+$/.test(c.classId)||typeof c.classCode!=='string'||!c.classCode.trim()||(!currentCourse||c.courseId!==undefined)&&(typeof c.courseId!=='string'||!c.courseId)))throw Error('OWNER_ENTRY_SCOPE_INVALID');
 const byClass=new Map(classes.map(c=>[c.classId,c]));
 const pendingOwners=new Map();
 const matches=(s,t)=>{const c=byClass.get(s.courseId);return !!c&&s.code===metadata.code&&s.version===metadata.version&&t?.classId===s.courseId&&t.studentRef===s.ownerId&&t.code===s.code&&t.version===s.version&&typeof t.courseId==='string'&&!!t.courseId&&(!c.courseId||t.courseId===c.courseId)&&(!c.courseWorkId||t.courseWorkId===c.courseWorkId);};
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
  // Teachers retain native access to historical work even after a learner leaves
  // the active roster. The verified binding sets scope; class permission is live.
  async resolveTeacher(documentId,authorize){const {scope}=await binding(documentId);await authorize(scope.courseId);return {documentId,classId:scope.courseId,studentRef:scope.ownerId,classCode:byClass.get(scope.courseId).classCode,code:metadata.code,version:metadata.version};},
  async assert(documentId,person){const {scope,target}=await binding(documentId);if(person.ownerId!==scope.ownerId||person.courseId!==scope.courseId)fail('HOMEWORK_ENTRY_OWNER_MISMATCH');await current(scope,target);},
  observation(documentId,person){return {code:metadata.code,version:metadata.version,documentId,
   async prepare(checked){
    if(!ownerSource||checked.owner)return checked;
    const key=JSON.stringify([person.courseId,person.ownerId]);
    if(!pendingOwners.has(key))pendingOwners.set(key,Promise.resolve().then(()=>ownerSource.member(person.courseId,person.ownerId)).finally(()=>pendingOwners.delete(key)));
    return {...checked,entryOwner:await pendingOwners.get(key)};
   },
   verify(rows,checked){
    if(rows.length!==1)fail('HOMEWORK_ENTRY_NOT_FOUND');const b=rows[0],scope={ownerId:b.owner_id,courseId:b.course_id,code:b.assignment_code,version:b.content_version},target=b.target;
    if(!matches(scope,target)||target.documentId!==documentId||!target.courseWorkId||!target.submissionId||!target.tabId)fail('HOMEWORK_ENTRY_NOT_FOUND');
    if(person.ownerId!==scope.ownerId||person.courseId!==scope.courseId)fail('HOMEWORK_ENTRY_OWNER_MISMATCH');
    if(checked.person?.ownerId!==person.ownerId||checked.person.courseId!==person.courseId||checked.person.className!==byClass.get(scope.courseId).classCode)fail('HOMEWORK_ENTRY_NOT_FOUND');
    const source=checked.entryOwner||checked.owner;
    if(ownerSource&&(source?.courseId!==target.courseId||source.googleUserId!==target.googleUserId))fail('HOMEWORK_ENTRY_NOT_FOUND');
   }};}
 };
}
