/**
 * Nhận snapshot quyền Reading V1 đã kiểm và phiên riêng của sản phẩm này.
 * Kiểm UUID–ERP–lớp ở mỗi request; bộ nhớ browser không cấp quyền. Google chỉ
 * xác minh GV, quyền lớp vẫn từ snapshot. Không ghi dữ liệu sang sản phẩm mẫu.
 */
import {randomBytes} from 'node:crypto';
import {sha256,WebGradingError} from './web-grader.js';
const DAY=86400000;
const secret=()=>randomBytes(32).toString('base64url');
const denied=(code='ACCESS_DENIED',status=403)=>{throw new WebGradingError(code,status);};
const bearer=q=>/^Bearer ([\w-]{43})$/.exec(q.headers.authorization||'')?.[1];
const cookie=q=>/(?:^|;\s*)reading67_teacher=([\w-]{43})(?:;|$)/.exec(q.headers.cookie||'')?.[1];

export function createReading67WebIdentity({db,context,allowedClassIds,verifyGoogle,ownerSource,clock=Date.now,cookiePath='/api/reading-skills67'}){
 const allowed=new Set(allowedClassIds.map(String));
 const courseAllowed=id=>{if(!allowed.has(String(id)))denied();};
 async function classes(){return (await context.classes()).filter(c=>allowed.has(c.id));}
 async function roster(classId){courseAllowed(classId);return (await (ownerSource?ownerSource.roster(classId):context.roster(classId))).map(s=>({studentRef:s.studentRef,name:s.name}));}
 async function member(classId,studentRef){
  courseAllowed(classId);
  const snapshot=await context.snapshot();
  const row=snapshot.students.find(s=>s.public_id===studentRef&&s.erp_course_class_id===String(classId)&&s.status==='approved');
  const active=row&&snapshot.memberships.some(m=>m.erp_course_class_id===String(classId)&&m.erp_student_contact_id===row.erp_student_contact_id&&m.source_state==='active');
  if(!active)denied('STUDENT_ACCESS_DENIED');
  if(ownerSource)await ownerSource.member(String(classId),studentRef);
  const c=snapshot.classes.find(c=>c.erp_course_class_id===String(classId));
  return {ownerId:row.public_id,courseId:String(classId),erpId:row.erp_student_contact_id,name:row.erp_student_name_snapshot,className:c.erp_class_name_snapshot};
 }
 async function resolve(input){
  const s=await context.snapshot();
  let rows=s.students.filter(r=>allowed.has(r.erp_course_class_id)&&r.status==='approved'&&s.memberships.some(m=>m.erp_course_class_id===r.erp_course_class_id&&m.erp_student_contact_id===r.erp_student_contact_id&&m.source_state==='active'));
  if(input.studentRef)rows=rows.filter(r=>r.public_id===input.studentRef);
  else rows=rows.filter(r=>r.erp_student_contact_id===input.identity.id);
  if(input.classCode)rows=rows.filter(r=>s.classes.find(c=>c.erp_course_class_id===r.erp_course_class_id)?.erp_class_name_snapshot.toUpperCase()===input.classCode);
  if(ownerSource){
   const eligible=[];
   for(const row of rows){try{await ownerSource.member(row.erp_course_class_id,row.public_id);eligible.push(row);}catch(error){if(error.code!=='STUDENT_ACCESS_DENIED')throw error;}}
   rows=eligible;
  }
  const ids=new Set(rows.map(r=>r.erp_student_contact_id));
  if(ids.size!==1)return {ok:true,status:ids.size?'ambiguous':'missing',identity:null,aliases:[]};
  return {ok:true,status:'unique',identity:{authority:'erp-contact',id:[...ids][0]},aliases:rows.map(r=>({classId:r.erp_course_class_id,classCode:s.classes.find(c=>c.erp_course_class_id===r.erp_course_class_id).erp_class_name_snapshot,studentRef:r.public_id,studentName:r.erp_student_name_snapshot}))};
 }
 async function loginStudent({classId,studentRef}){
  const identity=await member(classId,studentRef),token=secret();
  await db.query('INSERT INTO reading_listening67.web_student_session VALUES($1,$2,$3,$4,$5)',[sha256(token),identity.ownerId,identity.courseId,identity.erpId,new Date(clock()+30*DAY).toISOString()]);
  return {ok:true,token,identity};
 }
 async function authenticate(q){
  const token=bearer(q);if(!token)return null;
  const row=(await db.query('SELECT * FROM reading_listening67.web_student_session WHERE token_hash=$1 AND expires_at>$2',[sha256(token),new Date(clock()).toISOString()])).rows[0];
  if(!row)return null;
  const identity=await member(row.course_id,row.owner_id);if(identity.erpId!==row.erp_id)denied();
  return identity;
 }
 async function logoutStudent(q){const token=bearer(q);if(token)await db.query('DELETE FROM reading_listening67.web_student_session WHERE token_hash=$1',[sha256(token)]);}
 function writeCookie(q,r,token,row){
  r.cookie('reading67_teacher',token,{path:cookiePath,httpOnly:true,secure:q.secure,sameSite:q.secure?'none':'lax',partitioned:q.secure,...(!token?{maxAge:0}:row?.remembered?{maxAge:Math.max(0,Date.parse(row.expires_at)-clock())}:{})});
 }
 async function loginTeacher(q,r,{credential,remember=true}){
  let p;try{p=await verifyGoogle(credential);}catch{denied('GOOGLE_IDENTITY_INVALID',401);}
  if(!p?.email_verified||!p.email||!p.sub)denied('GOOGLE_IDENTITY_INVALID',401);
  const email=p.email.toLowerCase(),list=await classes();
  if(!(await Promise.all(list.map(c=>context.teacher(c.id,email,p.sub)))).some(Boolean))denied();
  const value=secret(),expires=new Date(clock()+(remember?90*DAY:3600000)).toISOString();
  await db.query('INSERT INTO reading_listening67.web_teacher_session VALUES($1,$2,$3,$4,$5,$6)',[sha256(value),email,p.sub,expires,new Date(clock()+(remember?365*DAY:3600000)).toISOString(),remember]);
  writeCookie(q,r,value,{remembered:remember,expires_at:expires});return {ok:true,email};
 }
 async function readTeacher(q){
  const token=cookie(q);if(!token)denied('TEACHER_LOGIN_REQUIRED',401);
  const row=(await db.query('SELECT * FROM reading_listening67.web_teacher_session WHERE token_hash=$1 AND expires_at>$2 AND absolute_expires_at>$2',[sha256(token),new Date(clock()).toISOString()])).rows[0];
  if(!row)denied('TEACHER_LOGIN_REQUIRED',401);return {...row,token};
 }
 async function authorizeTeacher(q,r,classId){
  courseAllowed(classId);const session=await readTeacher(q);
  if(!await context.teacher(String(classId),session.email,session.google_subject))denied();
  if(session.remembered){session.expires_at=new Date(Math.min(Date.parse(session.absolute_expires_at),clock()+90*DAY)).toISOString();await db.query('UPDATE reading_listening67.web_teacher_session SET expires_at=$2 WHERE token_hash=$1',[sha256(session.token),session.expires_at]);}
  writeCookie(q,r,session.token,session);return session;
 }
 async function teacherClasses(q){const session=await readTeacher(q),list=await classes(),result=[];for(const c of list)if(await context.teacher(c.id,session.email,session.google_subject))result.push(c);if(!result.length)denied();return result;}
 async function logoutTeacher(q,r){const token=cookie(q);if(token)await db.query('DELETE FROM reading_listening67.web_teacher_session WHERE token_hash=$1',[sha256(token)]);writeCookie(q,r,'');}
 return {classes,roster,member,resolve,loginStudent,authenticate,logoutStudent,loginTeacher,authorizeTeacher,teacherClasses,logoutTeacher};
}
