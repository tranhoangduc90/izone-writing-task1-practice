// Read-only authority snapshot. Validate the live contract, then narrow to K67.
import {sha256,WebGradingError} from '../reading-listening67/web-grader.js';
export function createListeningContext({url,key,fetcher=fetch,clock=Date.now,allowedClassIds,erpHomeworkClassIds=[]}){
 let cached,pending;const allowed=allowedClassIds?new Set(allowedClassIds.map(String)):null;
 const erpClasses=new Set(erpHomeworkClassIds.map(String));
 if([...erpClasses].some(id=>!['1333','1345'].includes(id)))throw Error('ERP_HOMEWORK_SCOPE_INVALID');
 const fail=()=>{throw new WebGradingError('CONTEXT_UNAVAILABLE',503);};
 async function load(){
  const response=await fetcher(url.replace(/\/$/,'')+'/v1/snapshot',{headers:{'x-k67-context-key':key},signal:AbortSignal.timeout(10000)});if(!response.ok)fail();const text=await response.text();if(Buffer.byteLength(text)>8*1024*1024)fail();let s;try{s=JSON.parse(text);}catch{fail();}
  const {capturedAt,sourceRevision,...payload}=s,age=clock()-Date.parse(capturedAt);
  if(s.apiVersion!==1||s.productId!=='PRODUCT-TERM-MINI-K67'||!Number.isFinite(age)||age< -5000||age>120000||sha256(JSON.stringify(payload))!==sourceRevision||!['classes','students','memberships','accounts','access'].every(k=>Array.isArray(s[k])&&s[k].length<100000))fail();
  if(new Set(s.classes.map(c=>c.erp_course_class_id)).size!==s.classes.length||new Set(s.students.map(c=>c.public_id)).size!==s.students.length)fail();
  const classes=s.classes.filter(c=>String(c.erp_course_id)==='5'&&(!allowed||allowed.has(c.erp_course_class_id))),ids=new Set(classes.map(c=>c.erp_course_class_id));
  const students=s.students.filter(r=>ids.has(r.erp_course_class_id));if(students.some(r=>typeof r.public_id!=='string'||!/^[0-9a-f-]{36}$/i.test(r.public_id)||typeof r.erp_student_contact_id!=='string'||typeof r.erp_student_name_snapshot!=='string'))fail();
  if(erpClasses.size){
   const response=await fetcher(url.replace(/\/$/,'')+'/v1/homework/erp-students',{headers:{'x-k67-context-key':key},signal:AbortSignal.timeout(10000)});
   if(!response.ok)fail();const body=await response.json(),age=clock()-Date.parse(body.capturedAt);
   if(body.ok!==true||!Number.isFinite(age)||age< -5000||age>120000||!Array.isArray(body.students)||body.students.length>2000)fail();
   const rows=body.students;
   if(new Set(rows.map(r=>r.public_id)).size!==rows.length||new Set(rows.map(r=>r.erp_course_class_id+':'+r.erp_student_contact_id)).size!==rows.length)fail();
   if(rows.some(r=>!['1333','1345'].includes(r.erp_course_class_id)||!['approved','pending_review'].includes(r.status)||typeof r.erp_student_name_snapshot!=='string'))fail();
   for(const row of students)if(erpClasses.has(row.erp_course_class_id)){
    const verified=rows.find(r=>r.public_id===row.public_id&&r.erp_course_class_id===row.erp_course_class_id&&r.erp_student_contact_id===row.erp_student_contact_id&&r.status===row.status);
    row.erpHomeworkEligible=!!verified;if(verified)row.erp_student_name_snapshot=verified.erp_student_name_snapshot;
   }
  }
  const result={...s,classes,students,memberships:s.memberships.filter(r=>ids.has(r.erp_course_class_id)),access:s.access.filter(r=>ids.has(r.erp_course_class_id))};cached={at:clock(),value:result};return result;
 }
 async function snapshot(){if(cached&&clock()-cached.at<30000&&clock()-Date.parse(cached.value.capturedAt)<120000)return cached.value;if(pending)return pending;pending=load();try{return await pending;}catch{fail();}finally{pending=null;}}
 function isStudyStudent(row){return erpClasses.has(row.erp_course_class_id)?row.erpHomeworkEligible===true:row.status==='approved';}
 async function roster(id){const s=await snapshot();return s.students.filter(r=>r.erp_course_class_id===String(id)&&isStudyStudent(r)&&s.memberships.some(m=>m.erp_course_class_id===r.erp_course_class_id&&m.erp_student_contact_id===r.erp_student_contact_id&&m.source_state==='active')).map(r=>({studentRef:r.public_id,name:r.erp_student_name_snapshot}));}
 async function classes(){const s=await snapshot();return s.classes.map(c=>({id:c.erp_course_class_id,classCode:c.erp_class_name_snapshot})).sort((a,b)=>a.classCode.localeCompare(b.classCode));}
 async function teacher(id,email,sub){const s=await snapshot(),account=s.accounts.find(a=>a.email===email.toLowerCase()&&a.status==='active');return !!account&&(!account.google_subject||account.google_subject===sub)&&(account.role==='admin'||account.can_access_all_classes||s.access.some(a=>a.reviewer_email===account.email&&a.erp_course_class_id===String(id)));}
 return {snapshot,roster,classes,teacher,isStudyStudent};
}
