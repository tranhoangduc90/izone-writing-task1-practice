// Nguồn Classroom/mapping giả, Docs có cấu trúc thật: kiểm chọn đúng chủ/đích trước ghi.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createReading67HomeworkOwner} from '../src/reading-listening67/web-homework-owner.js';
import {HOMEWORK_CTA,HOMEWORK_STATUS} from '../src/reading-listening67/web-homework-docs.js';
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const code='67-reading-materials-beyond-concrete-matching-information-nen-cap-1',version='fixture-v1';
const scope={ownerId:A,courseId:'1124',code,version};
const target={classId:'1124',studentRef:A,code,version,courseId:'course-A',courseWorkId:'work78',submissionId:'submission-A',documentId:'copy-A',tabId:'child'};
const p=(start,text)=>({paragraph:{elements:[{startIndex:start,textRun:{content:text+'\n'}}]}});
function doc(id){return {documentId:id,revisionId:'revision-fixture',tabs:[{tabProperties:{tabId:'parent'},childTabs:[{tabProperties:{tabId:'child'},documentTab:{body:{content:[p(1,HOMEWORK_CTA),p(100,code),{table:{tableRows:[{tableCells:[{content:[p(300,HOMEWORK_STATUS)]}]},{tableCells:[{content:[p(500,'Chữ tay giữ nguyên')]}]}]}}]}}}]}]};}
function fixture(){
 let now=Date.parse('2026-10-22T06:00:00Z');
 const source={apiVersion:1,classId:'1124',studentRef:A,courseId:'course-A',googleUserId:'google-A'};
 const work={id:'work78',courseId:'course-A',title:'LỚP THỬ — Homework Lesson 78',materials:[{driveFile:{shareMode:'STUDENT_COPY',driveFile:{id:'template'}}}]};
 const submission={id:'submission-A',courseId:'course-A',courseWorkId:'work78',userId:'google-A',assignmentSubmission:{attachments:[{driveFile:{id:'copy-A'}}]}};
 const state={source,work,submission,age:0,extra:[],duplicate:false,calls:[],pages:true,manualDoc:doc('copy-A'),badHash:false};
 const response=value=>new Response(JSON.stringify(value));
 const api=createReading67HomeworkOwner({url:'https://owner.test',key:'private-test-key',auth:{getAccessToken:async()=>({token:'fake'})},docs:{read:async id=>{state.calls.push('doc:'+id);return {...structuredClone(state.manualDoc),documentId:id};}},metadata:{code,version,homeworkLesson:78},clock:()=>now,fetcher:async url=>{
  const u=new URL(url);state.calls.push(u.pathname+u.search);
  if(u.hostname==='owner.test'){
   const hash=createHash('sha256').update(JSON.stringify(source)).digest('hex');
   return response({...source,capturedAt:new Date(now-state.age).toISOString(),sourceRevision:state.badHash?'a'.repeat(64):hash});
  }
  if(u.pathname.endsWith('/courseWork')){
   if(state.pages&&!u.searchParams.get('pageToken'))return response({courseWork:[{...work,id:'work780',title:'Homework Lesson 780'},...state.extra],nextPageToken:'second'});
   return response({courseWork:[work,...(state.duplicate?[{...work,id:'work78-again'}]:[])]});
  }
  if(u.pathname.endsWith('/studentSubmissions'))return response({studentSubmissions:[{...submission,courseWorkId:u.pathname.includes('work78-again')?'work78-again':submission.courseWorkId}]});
  if(u.pathname.includes('/studentSubmissions/'))return response(submission);
  if(u.pathname.endsWith('/work78')||u.pathname.endsWith('/work78-again'))return response(work);
  throw Error('Unexpected route '+u.pathname);
 }});
 return {api,state,advance:ms=>{now+=ms;}};
}
test('Tìm đủ trang Homework mới, bỏ buổi gần giống, đúng bản sao và child tab; cache vẫn xác minh lại',async()=>{
 const f=fixture(),found=await f.api.resolve(scope);assert.equal(found.documentId,'copy-A');assert.equal(found.tabId,'child');assert.equal(found.submissionId,'submission-A');
 assert.ok(f.state.calls.some(c=>c.includes('pageToken=second')));
 const before=f.state.calls.length;await f.api.resolve(scope,found);assert.ok(f.state.calls.length>before);
 f.state.submission.userId='google-other';await assert.rejects(f.api.resolve(scope,found),e=>e.code==='DOCUMENT_OWNER_MISMATCH');
});
test('Không chọn theo tên, không nhận UUID/lớp/Google user sai hoặc nguồn mapping cũ/hash hỏng',async()=>{
 for(const change of [f=>{f.state.source.studentRef=B;},f=>{f.state.source.classId='1131';},f=>{f.state.age=120001;},f=>{f.state.age=-5001;},f=>{f.state.badHash=true;}]){
  const f=fixture();change(f);await assert.rejects(f.api.resolve(scope),e=>['OWNER_MISMATCH','OWNER_SOURCE_INVALID'].includes(e.code));assert.ok(!f.state.calls.some(c=>c.startsWith('doc:')));
 }
 const f=fixture();await assert.rejects(f.api.resolveClassroom({courseId:'course-A',googleUserId:'google-B'}),e=>e.code==='OWNER_MISMATCH');
});
test('Bài chỉ giao riêng người khác bị bỏ qua trước khi hỏi submission; không nuốt nhầm 404',async()=>{
 const f=fixture();f.state.extra=[{...f.state.work,id:'other-person',assigneeMode:'INDIVIDUAL_STUDENTS',individualStudentsOptions:{studentIds:['google-other']}}];
 assert.equal((await f.api.resolve(scope)).documentId,'copy-A');assert.ok(!f.state.calls.some(c=>c.includes('other-person/studentSubmissions')));
});
test('Homework cùng buổi chỉ có tài liệu tham khảo bị bỏ qua, không che bản sao hợp lệ',async()=>{
 const f=fixture();f.state.extra=[{...f.state.work,id:'reference-only',materials:[{driveFile:{shareMode:'VIEW',driveFile:{id:'reference'}}}]}];
 assert.equal((await f.api.resolve(scope)).documentId,'copy-A');assert.ok(!f.state.calls.some(c=>c.includes('reference-only/studentSubmissions')));
});
test('Không ghi bản mẫu, bản sao không nằm trong submission, sai số buổi hoặc sai lớp Classroom',async()=>{
 for(const change of [f=>{f.state.submission.assignmentSubmission.attachments[0].driveFile.id='template';},f=>{f.state.work.title='Homework Lesson 79';},f=>{f.state.work.courseId='course-other';},f=>{f.state.submission.courseWorkId='other-work';},f=>{f.state.submission.id='other-submission';}]){
  const f=fixture();change(f);await assert.rejects(f.api.verify(target),e=>['DOCUMENT_OWNER_MISMATCH','HOMEWORK_LESSON_MISMATCH'].includes(e.code));
 }
});
test('Chưa có Homework giữ lỗi chờ; nhiều đích, tab/mã sai hoặc đích cache đổi chủ không được chọn đích đầu',async()=>{
 const missing=fixture();missing.state.work.title='Homework Lesson 79';await assert.rejects(missing.api.resolve(scope),e=>e.code==='HOMEWORK_NOT_FOUND');
 const duplicate=fixture();duplicate.state.duplicate=true;await assert.rejects(duplicate.api.resolve(scope),e=>e.code==='DOC_STATUS_AMBIGUOUS');
 const other=fixture();await assert.rejects(other.api.resolve(scope,{...target,studentRef:B}),e=>e.code==='DOC_IDENTITY_MISMATCH');
 await assert.rejects(other.api.verify({...target,tabId:'missing'}),e=>e.code==='DOC_TAB_NOT_FOUND');
 await assert.rejects(other.api.verify({...target,version:'other'}),e=>e.code==='DOC_CODE_MISMATCH');
});
