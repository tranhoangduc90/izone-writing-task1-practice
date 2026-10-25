import {sha} from './grading.mjs';
import {relocateTeacherCommentAnchor} from '../vendor/teacher-comment-service.js';
const fields=['overview','body1','body2','draft1','draft2'];
export function projectHistory(snapshot){
 const t=snapshot.tables,by=(rows,key)=>new Map(rows.map(x=>[x[key],x]));
 const sessions=by(t.activity_session,'public_id'),internal=by(t.activity_session,'id'),attempts=by(t.check_attempt,'public_id'),threads=by(t.teacher_comment_thread,'public_id'),classes=by(t.activity_class_scope,'id'),activities=by(t.activity,'id');
 const related=(rows,id)=>rows.filter(x=>x.session_id===id);
 function details(ref){
  const s=sessions.get(ref);if(!s)return null;const c=classes.get(s.activity_class_id),a=activities.get(s.activity_id);
  const checks=related(t.check_attempt,s.id).sort((a,b)=>Date.parse(b.created_at)-Date.parse(a.created_at));
  const sections=Object.fromEntries(related(t.session_section,s.id).map(x=>[x.section_key,{status:x.locked?'passed':x.fail_streak?'revision':'draft',locked:x.locked,failStreak:x.fail_streak,attemptsWithoutPass:x.fail_streak,roundNumber:x.round_number}]));
  for(const key of Object.keys(sections)){const latest=checks.find(x=>x.section_key===key);if(latest&&['queued','leased','failed'].includes(latest.status))sections[key].status=latest.status==='failed'?'technical_error':'queued';}
  const comments=related(t.comment,s.id).sort((a,b)=>a.comment_number-b.comment_number).map(x=>{const old=t.check_attempt.find(a=>a.id===x.attempt_id);return {commentRef:x.public_id,attemptRef:old?.public_id,section:x.section_key,commentNumber:x.comment_number,status:x.status,feedback:x.content,createdAt:x.created_at,artifacts:old?.result_artifacts||{},canRetry:false};});
  return {id:s.id,sessionRef:s.public_id,studentRef:s.student_public_id,classRef:c.public_id,activitySlug:a.slug,...Object.fromEntries(fields.map(k=>[k,s[k]||''])),responses:Object.fromEntries(fields.map(k=>[k,s[k]||''])),draftVersion:s.draft_version,draft2Unlocked:s.draft2_unlocked,updatedAt:s.updated_at,sections,comments,attempts:checks.map(x=>({attemptRef:x.public_id,section:x.section_key,commentNumber:x.comment_number,status:x.status,resultStatus:x.result_status,errorCode:x.error_code,createdAt:x.created_at,completedAt:x.completed_at})),readOnly:true,historyCapturedAt:snapshot.capturedAt};
 }
 function comments(ref){
  const s=sessions.get(ref);if(!s)return null;
  const items=related(t.teacher_comment_thread,s.id).map(x=>({threadRef:x.public_id,sectionKey:x.section_key,fieldKey:x.field_key,status:x.status,anchor:{...relocateTeacherCommentAnchor(s[x.field_key]||'',{start:x.anchor_start,end:x.anchor_end,quote:x.anchor_quote,prefix:x.anchor_prefix,suffix:x.anchor_suffix}),originalStart:x.anchor_start,originalEnd:x.anchor_end},anchorRevision:x.anchor_revision,createdAt:x.created_at,updatedAt:x.updated_at,messages:t.teacher_comment_message.filter(m=>m.thread_id===x.id).map(m=>({messageRef:m.public_id,authorRole:m.author_role,body:m.body,createdAt:m.created_at}))}));
  return {threads:items,version:sha(items).slice(0,24)};
 }
 function students(slug){
  const relevant=new Set(t.activity.filter(x=>x.slug===slug).map(x=>x.id));
  return t.activity_roster.filter(r=>relevant.has(classes.get(r.activity_class_id)?.activity_id)).map(r=>{
   const c=classes.get(r.activity_class_id),s=t.activity_session.find(s=>s.activity_class_id===r.activity_class_id&&s.student_public_id===r.student_public_id),d=s?details(s.public_id):null;
   const responses=d?.responses||Object.fromEntries(fields.map(k=>[k,'']));const filledFields=Object.values(responses).filter(x=>x.trim()).length;
   return {studentRef:r.student_public_id,displayName:r.display_alias,classRef:c.public_id,className:c.class_name_snapshot,sessionRef:s?.public_id||null,updatedAt:s?.updated_at||null,responses,sections:d?.sections||{},filledFields,fieldCount:5,progressPercent:Math.round(filledFields/5*100),passedSectionCount:Object.values(d?.sections||{}).filter(x=>x.locked).length,sectionCount:3,checkCount:d?.attempts.length||0,supportRequired:Object.values(d?.sections||{}).some(x=>x.failStreak>=3),readOnly:true,historyCapturedAt:snapshot.capturedAt};
  });
 }
 function target(q){
  const ids=q.path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/ig)||[];
  for(const id of ids){if(sessions.has(id))return details(id);if(attempts.has(id))return details(internal.get(attempts.get(id).session_id).public_id);if(threads.has(id))return details(internal.get(threads.get(id).session_id).public_id);}
  const c=t.activity_class_scope.find(x=>x.public_id===q.body?.classRef);return c?{classRef:c.public_id,readOnly:true}:null;
 }
 function attempt(ref){const a=attempts.get(ref);if(!a)return null;const d=details(internal.get(a.session_id).public_id),comment=d.comments.find(c=>c.attemptRef===ref);return {attemptRef:ref,section:a.section_key,status:a.status,resultStatus:a.result_status,errorCode:a.error_code,feedback:a.feedback,artifacts:a.result_artifacts||{},version:a.version,canRetry:false,comment,readOnly:true};}
 return {details,comments,students,target,attempt,metadata:{capturedAt:snapshot.capturedAt,counts:Object.fromEntries(Object.entries(t).map(([k,v])=>[k,v.length]))}};
}
export function createHistory({pool}){
 let pending;
 return async()=>{
  if(!pending)pending=pool.query('SELECT original_text,sha256 FROM task1_private.history_snapshot WHERE id=1').then(r=>{if(!r.rowCount)return null;const row=r.rows[0];if(sha(row.original_text)!==row.sha256)throw Error('HISTORY_SNAPSHOT_HASH_MISMATCH');return projectHistory(JSON.parse(row.original_text));}).catch(e=>{pending=null;throw e;});
  return pending;
 };
}
