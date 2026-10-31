import express from 'express';

// Chọn đúng bài bằng mã ổn định; đường cũ luôn giữ bài mặc định.
// Mã lạ bị từ chối trước khi đọc/ghi nháp hoặc nhận việc chấm.
export function createListeningLessonRouter(entries,{defaultCode,aliases={}}={}){
 const app=express(),registry=new Map();
 for(const entry of entries){
  if(!entry.code||registry.has(entry.code))throw Error('DUPLICATE_LISTENING_LESSON');
  registry.set(entry.code,entry.app);
 }
 if(!registry.has(defaultCode))throw Error('DEFAULT_LISTENING_LESSON_REQUIRED');
 app.use((q,r,next)=>{
  const requested=q.query.assignmentCode;
  if(requested!==undefined&&(typeof requested!=='string'||requested.length>160))return r.status(400).json({error:'ASSIGNMENT_CODE_INVALID'});
  const code=aliases[requested]||requested||defaultCode,selected=registry.get(code);
  if(!selected)return r.status(404).json({error:'LISTENING_LESSON_NOT_FOUND'});
  selected(q,r,next);
 });
 return app;
}
