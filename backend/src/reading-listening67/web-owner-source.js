/**
 * Đọc nguồn owner V1 hiện hành bằng UUID; không truy vấn database mapping.
 * Dùng cùng điều kiện cho chọn tên, mở phiên và tra Google ID của sự kiện CTA.
 * Nguồn lỗi/cũ dừng kiểm; chỉ 403 được hiểu là hồ sơ chưa đủ điều kiện.
 */
import {z} from 'zod';
import {sha256,WebGradingError} from './web-grader.js';
const schema=z.object({apiVersion:z.literal(1),classId:z.string(),studentRef:z.uuid(),courseId:z.string().min(1),googleUserId:z.string().min(1),capturedAt:z.iso.datetime(),sourceRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
const fail=(code,status=403)=>{throw new WebGradingError(code,status);};
export function createReading67OwnerSource({context,allowedClassIds,url,key,fetcher=fetch,clock=Date.now}){
 const allowed=new Set(allowedClassIds.map(String));
 async function candidates(classId){
  classId=String(classId);if(!allowed.has(classId))fail('STUDENT_ACCESS_DENIED');
  const s=await context.snapshot();
  return s.students.filter(r=>r.erp_course_class_id===classId&&r.status==='approved'&&s.memberships.some(m=>m.erp_course_class_id===classId&&m.erp_student_contact_id===r.erp_student_contact_id&&m.source_state==='active'));
 }
 async function read(classId,studentRef){
  let response;
  try{response=await fetcher(url.replace(/\/$/,'')+'/v1/owner?'+new URLSearchParams({classId:String(classId),studentRef}),{headers:{'x-reading-owner-key':key},signal:AbortSignal.timeout(5000)});}catch{fail('OWNER_SOURCE_UNAVAILABLE',503);}
  if(response.status===403)return null;
  if(!response.ok)fail('OWNER_SOURCE_UNAVAILABLE',503);
  let raw;try{raw=await response.json();}catch{fail('OWNER_SOURCE_INVALID',503);}
  const parsed=schema.safeParse(raw);if(!parsed.success)fail('OWNER_SOURCE_INVALID',503);
  const {capturedAt,sourceRevision,...value}=parsed.data,age=clock()-Date.parse(capturedAt);
  if(age < -5000||age>120000||sha256(JSON.stringify(value))!==sourceRevision||value.classId!==String(classId)||value.studentRef!==studentRef)fail('OWNER_MISMATCH');
  return {...value,capturedAt,sourceRevision};
 }
 async function member(classId,studentRef){
  if(!(await candidates(classId)).some(r=>r.public_id===studentRef))fail('STUDENT_ACCESS_DENIED');
  const value=await read(classId,studentRef);if(!value)fail('STUDENT_ACCESS_DENIED');return value;
 }
 async function roster(classId){
  const rows=await candidates(classId);if(rows.length>200)fail('OWNER_LOOKUP_LIMIT',503);
  const result=[];
  // Giới hạn bốn lời gọi đồng thời; không biến lỗi một nguồn thành roster thiếu người.
  for(let i=0;i<rows.length;i+=4){
   const batch=await Promise.all(rows.slice(i,i+4).map(async row=>{const owner=await read(classId,row.public_id);return owner?{...owner,name:row.erp_student_name_snapshot}:null;}));
   result.push(...batch.filter(Boolean));
  }
  return result;
 }
 async function resolveClassroom(input){
  const results=[];
  for(const classId of allowed)results.push(...(await roster(classId)).filter(r=>r.courseId===input.courseId&&r.googleUserId===input.googleUserId));
  if(results.length!==1)fail('OWNER_MISMATCH');
  // Kiểm lại người đã chọn ngay trước nhận event; không dựa vào tên hoặc phần tử đầu.
  const checked=await member(results[0].classId,results[0].studentRef);
  if(checked.courseId!==input.courseId||checked.googleUserId!==input.googleUserId)fail('OWNER_MISMATCH');return checked;
 }
 return {member,roster,resolveClassroom};
}
