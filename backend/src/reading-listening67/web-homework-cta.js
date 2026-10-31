/**
 * Nhận một event giao Homework như Reading/Listening, không tin URL CTA cũ.
 * Xác minh mapping và bản sao trước đăng ký. Trả verified sau worker/readback;
 * pending là lỗi có thể thử lại cùng event, không giả đã gắn hoặc đã nộp Classroom.
 */
import {WebGradingError} from './web-grader.js';
import {locateReading67Homework,planReading67HomeworkWrite} from './web-homework-docs.js';
const tabs=list=>(list||[]).flatMap(t=>[t,...tabs(t.childTabs)]);
const text=content=>(content||[]).map(e=>(e.paragraph?.elements||[]).map(r=>r.textRun?.content||'').join('')+(e.table?.tableRows||[]).map(r=>(r.tableCells||[]).map(c=>text(c.content)).join('')).join('')).join('');
const fail=(code,status=409)=>{throw new WebGradingError(code,status);};
// Chọn đúng bài trước bất kỳ ghi nào; một Docs chứa hai mã được quản lý phải dừng.
export function createReading67CtaDispatcher({docs,registrars}){
 if(!registrars?.length||new Set(registrars.map(r=>r.code)).size!==registrars.length)throw Error('CTA_REGISTRARS_INVALID');
 return async event=>{
  const document=await docs.read(event.doc_id);
  if(document.documentId!==event.doc_id)fail('DOC_IDENTITY_MISMATCH');
  const matching=document=>{const body=tabs(document.tabs).map(t=>text(t.documentTab?.body?.content)).join('\n');return registrars.filter(r=>body.includes(r.code));};
  const matches=matching(document);
  if(matches.length>1)fail('DOC_CODE_MISMATCH');
  if(!matches.length)return {documentId:event.doc_id,status:'not_applicable',assignmentCode:registrars[0].code};
  const selected=matches[0];
  const documentGuard=doc=>{const current=matching(doc);if(doc.documentId!==event.doc_id||current.length!==1||current[0].code!==selected.code)fail('DOC_CODE_MISMATCH');};
  return selected.registerCta(event,{documentGuard});
 };
}
export function createReading67CtaRegistrar({homework,owner,docs,identity,metadata,waitMs=12000,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),locate=locateReading67Homework,planWrite=planReading67HomeworkWrite}){
 return async (event,{documentGuard}={})=>{
  const document=await docs.read(event.doc_id);
  if(document.documentId!==event.doc_id)fail('DOC_IDENTITY_MISMATCH');
  documentGuard?.(document);
  const found=tabs(document.tabs).filter(t=>text(t.documentTab?.body?.content).includes(metadata.code));
  if(!found.length)return {documentId:event.doc_id,status:'not_applicable',assignmentCode:metadata.code};
  if(found.length!==1)fail('DOC_CODE_MISMATCH');
  const tabId=found[0].tabProperties.tabId;
  locate(document,{document_id:event.doc_id,tab_id:tabId,code:metadata.code});
  const source=await owner.resolveClassroom({courseId:event.classroom_course_id,googleUserId:event.student_id});
  const person=await identity.member(source.classId,source.studentRef);
  if(person.className!==event.class_name)fail('CTA_CLASS_MISMATCH',403);
  const scope={ownerId:source.studentRef,courseId:source.classId,code:metadata.code,version:metadata.version};
  const target={classId:source.classId,studentRef:source.studentRef,code:metadata.code,version:metadata.version,courseId:event.classroom_course_id,courseWorkId:event.coursework_id,submissionId:event.submission_id,documentId:event.doc_id,tabId};
  await homework.register(scope,target,{documentGuard});
  const deadline=Date.now()+waitMs;
  do{
   const state=await homework.status(scope);
   if(state.cta==='blocked')fail('CTA_WRITE_BLOCKED');
   if(state.cta==='verified'){
    const entryUrl=state.entryUrl||homework.entryUrl;
    const readback=planWrite(await docs.read(event.doc_id),{document_id:event.doc_id,tab_id:tabId,code:metadata.code},{kind:'cta',payload:{url:entryUrl}});
    if(!readback.verified)fail('DOC_READBACK_FAILED',503);
    return {documentId:event.doc_id,status:'verified',assignmentCode:metadata.code,entryUrl};
   }
   if(Date.now()>=deadline)break;
   await sleep(250);
  }while(true);
  fail('CTA_PENDING',503);
 };
}
