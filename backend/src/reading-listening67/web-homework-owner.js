/**
 * Nối UUID/lớp với bản sao Homework qua nguồn mapping V1 và Classroom.
 * Kế thừa contract Reading; không chọn theo tên hoặc tài liệu đầu. Đích đã nhớ
 * vẫn kiểm lại, thiếu/mơ hồ/sai chủ trả mã lỗi trước khi writer được gọi.
 */
import {z} from 'zod';
import {sha256,WebGradingError} from './web-grader.js';
import {homeworkMarkerTabs,locateReading67Homework} from './web-homework-docs.js';
const fail=(code,status=409)=>{throw new WebGradingError(code,status);};
const sourceSchema=z.object({apiVersion:z.literal(1),classId:z.string(),studentRef:z.uuid(),courseId:z.string().min(1),googleUserId:z.string().min(1),capturedAt:z.iso.datetime(),sourceRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();

export function createReading67HomeworkOwner({url,key,headerName='x-reading-owner-key',auth,docs,metadata,ownerSource,fetcher=fetch,clock=Date.now,locate=locateReading67Homework}){
 async function mapping(input,reverse=false){
  if(ownerSource)return reverse?ownerSource.resolveClassroom(input):ownerSource.member(input.classId,input.studentRef);
  const query=new URLSearchParams(reverse?{courseId:input.courseId,googleUserId:input.googleUserId}:{classId:input.classId,studentRef:input.studentRef});
  let response;
  try{response=await fetcher(url.replace(/\/$/,'')+(reverse?'/v1/owner-by-classroom?':'/v1/owner?')+query,{headers:{[headerName]:key},signal:AbortSignal.timeout(5000)});}catch{fail('OWNER_SOURCE_UNAVAILABLE',503);}
  if(reverse&&response.status===403)fail('OWNER_NOT_MAPPED',403);
  if(!response.ok)fail('OWNER_SOURCE_UNAVAILABLE',503);
  const parsed=sourceSchema.safeParse(await response.json());if(!parsed.success)fail('OWNER_SOURCE_INVALID',503);
  const {capturedAt,sourceRevision,...payload}=parsed.data,age=clock()-Date.parse(capturedAt);
  if(age < -5000||age>120000||sha256(JSON.stringify(payload))!==sourceRevision)fail('OWNER_MISMATCH',403);
  if(reverse?(payload.courseId!==input.courseId||payload.googleUserId!==input.googleUserId):(payload.classId!==input.classId||payload.studentRef!==input.studentRef))fail('OWNER_MISMATCH',403);
  return {...payload,sourceRevision};
 }
 async function classroom(path,params={},deadline=clock()+40000){
  const remaining=deadline-clock();if(remaining<=0)fail('HOMEWORK_LOOKUP_TIMEOUT',503);
  const token=await auth.getAccessToken(),endpoint=new URL('https://classroom.googleapis.com/v1/'+path);
  for(const [k,v] of Object.entries(params))if(v!==undefined)endpoint.searchParams.set(k,v);
  const r=await fetcher(endpoint.href,{headers:{Authorization:'Bearer '+(typeof token==='string'?token:token.token)},signal:AbortSignal.timeout(Math.min(10000,remaining))});
  if(!r.ok)fail('HOMEWORK_HTTP_'+r.status,503);return r.json();
 }
 async function list(path,field,params,deadline){
  const items=[],seen=new Set();let pageToken;
  do{const page=await classroom(path,{...params,pageSize:'100',pageToken},deadline);items.push(...(page[field]||[]));pageToken=page.nextPageToken;
   if(pageToken){if(seen.has(pageToken)||seen.size>=9)fail('HOMEWORK_LOOKUP_LIMIT',503);seen.add(pageToken);}
  }while(pageToken);return items;
 }
 function eligible(work,source){
  return work.courseId===source.courseId&&work.id&&work.state==='PUBLISHED'&&work.workType==='ASSIGNMENT'&&
   (work.assigneeMode!=='INDIVIDUAL_STUDENTS'||work.individualStudentsOptions?.studentIds?.includes(source.googleUserId));
 }
 const templatesFor=work=>(work.materials||[]).filter(m=>m.driveFile?.shareMode==='STUDENT_COPY').map(m=>m.driveFile.driveFile?.id).filter(Boolean);
 function checkWork(work,source){
  if(!eligible(work,source))fail('DOCUMENT_OWNER_MISMATCH',403);
  const templates=templatesFor(work);
  if(!templates.length)fail('DOCUMENT_OWNER_MISMATCH',403);return templates;
 }
 function checkSubmission(s,source,workId){
  if(!s.id||s.userId!==source.googleUserId||s.courseId!==source.courseId||s.courseWorkId!==workId)fail('DOCUMENT_OWNER_MISMATCH',403);
 }
 async function verify(target){
  if(target.code!==metadata.code||target.version!==metadata.version)fail('DOC_CODE_MISMATCH');
  const source=await mapping(target);
  if(source.courseId!==target.courseId)fail('OWNER_MISMATCH',403);
  const base='courses/'+encodeURIComponent(source.courseId)+'/courseWork/'+encodeURIComponent(target.courseWorkId);
  const work=await classroom(base),templates=checkWork(work,source);
  if(work.id!==target.courseWorkId||templates.includes(target.documentId))fail('DOCUMENT_OWNER_MISMATCH',403);
  const s=await classroom(base+'/studentSubmissions/'+encodeURIComponent(target.submissionId));checkSubmission(s,source,work.id);
  const files=(s.assignmentSubmission?.attachments||[]).filter(a=>a.driveFile?.id===target.documentId);
  if(s.id!==target.submissionId||files.length!==1)fail('DOCUMENT_OWNER_MISMATCH',403);
  locate(await docs.read(target.documentId),{document_id:target.documentId,tab_id:target.tabId,code:metadata.code});
  return {...target,googleUserId:source.googleUserId,sourceRevision:source.sourceRevision,verifiedAt:new Date(clock()).toISOString()};
 }
 async function resolve(scope,cached){
  const identity={classId:scope.courseId,studentRef:scope.ownerId,code:scope.code,version:scope.version};
  if(identity.code!==metadata.code||identity.version!==metadata.version)fail('DOC_CODE_MISMATCH');
  if(cached){if(Object.keys(identity).some(k=>identity[k]!==cached[k]))fail('DOC_IDENTITY_MISMATCH');return verify(cached);}
  const source=await mapping(identity),deadline=clock()+40000,base='courses/'+encodeURIComponent(source.courseId);
  const works=await list(base+'/courseWork','courseWork',{courseWorkStates:'PUBLISHED'},deadline);
  const candidates=new Map(works.filter(w=>eligible(w,source)&&templatesFor(w).length).map(w=>[w.id,templatesFor(w)]));
  if(!candidates.size)fail('HOMEWORK_NOT_FOUND');
  const submissions=await list(base+'/courseWork/-/studentSubmissions','studentSubmissions',{userId:source.googleUserId},deadline);
  const documents=new Map(),targets=new Map();
  for(const s of submissions){
   const templates=candidates.get(s.courseWorkId);
   if(!templates)continue;
   checkSubmission(s,source,s.courseWorkId);
   for(const a of s.assignmentSubmission?.attachments||[]){
    const documentId=a.driveFile?.id;if(!documentId||templates.includes(documentId))continue;
    if(!documents.has(documentId)){
     const remaining=deadline-clock();
     if(remaining<=0)fail('HOMEWORK_LOOKUP_TIMEOUT',503);
     const doc=await docs.read(documentId,{timeoutMs:remaining});
     if(doc.documentId!==documentId)fail('DOC_IDENTITY_MISMATCH');
     documents.set(documentId,homeworkMarkerTabs(doc,metadata.code));
    }
    const markers=documents.get(documentId);
    if(markers.length>1)fail('DOC_CODE_MISMATCH');
    if(!markers.length)continue;
    const target={...identity,courseId:source.courseId,courseWorkId:s.courseWorkId,submissionId:s.id,documentId,tabId:markers[0]};
    targets.set(JSON.stringify(target),target);
    if(targets.size>1)fail('DOC_STATUS_AMBIGUOUS');
   }
  }
  if(!targets.size)fail('HOMEWORK_NOT_FOUND');
  return verify(targets.values().next().value);
 }
 return {verify,resolve,resolveClassroom:input=>mapping(input,true)};
}
