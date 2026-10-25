import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {createService} from '../src/service.mjs';
import {sha} from '../src/grading.mjs';
export const feedback={overview:'Overview đã đạt 👍 Em đã nêu đúng nhận xét chính. Em chuyển sang hoạt động chia thân bài.',outline:'Outline hai thân bài đã đạt 👍 Em đã chia nhóm có căn cứ. Em chuyển sang hoạt động viết Draft.',draft:'Draft đã đạt 👍 Nội dung và cách diễn đạt đã rõ. Em giữ lại bản viết này.'};
export const revision='1. **Chẩn đoán:** Sai đơn vị.\n**Phân tích:** Cụm em dùng chưa diễn đạt đúng phép so sánh.\n**Gợi mở:** Em đang mô tả hiệu tuyệt đối hay thay đổi tương đối?\n**Next step:** Em tự sửa đơn vị, giữ phần đúng.';
export function adapt(db){
 let tail=Promise.resolve();
 const result=async(sql,args)=>{const r=await db.query(sql,args);return {...r,rowCount:r.rows.length||r.affectedRows||0};};
 const lock=async()=>{let release;const prior=tail;tail=new Promise(r=>{release=r;});await prior;return release;};
 return {query:async(sql,args)=>{const unlock=await lock();try{return await result(sql,args);}finally{unlock();}},connect:async()=>{const release=await lock();return {query:result,release};}};
}
export async function setup(t){
 globalThis.gc?.(); // Release previous closed WASM databases when the runner exposes GC.
 const db=new PGlite();if(t)t.after(()=>db.close());
 await db.exec(await fs.readFile(new URL('../db/001-initial.sql',import.meta.url),'utf8'));
 const pool=adapt(db),service=createService({pool,pepper:'test-pepper-'.repeat(4)});
 const activity=(await pool.query(`INSERT INTO writing_practice.activity(slug,content_version,manifest_checksum,title,task_prompt,prompt_record_ref,prompt_version,end_date,status) VALUES('task1-fixture','test',$1,'Đề thử','Biểu đồ thử','fixture','test','2030-12-31','active') RETURNING id`,['a'.repeat(64)])).rows[0];
 const c=(await pool.query(`INSERT INTO writing_practice.activity_class_scope(activity_id,erp_course_class_id,class_name_snapshot,end_date) VALUES($1,999001,'TASK1-THU','2030-12-31') RETURNING id,public_id`,[activity.id])).rows[0];
 const studentRef=randomUUID();await pool.query(`INSERT INTO writing_practice.activity_roster(activity_class_id,student_public_id,display_name,display_alias) VALUES($1,$2,'Học viên thử','Học viên thử')`,[c.id,studentRef]);
 for(const section of ['overview','outline','draft']){
  const template='Đề: {{ $json.de_bai }}\n{{ $json.overview }}\n{{ $json.body_1 }}\n{{ $json.body_2 }}\n{{ $json.draft1 }}\n{{ $json.draft2 }}\n{{FEEDBACK_HISTORY}}';
  await pool.query('INSERT INTO task1_private.prompt VALUES($1,$2,$3,$4,$5)',['task1-fixture',section,'test',template,sha(template)]);
 }
 const session=await service.openSession({activitySlug:'task1-fixture',classRef:c.public_id,studentRef});
 const snapshot={overview:'Nhận xét thử',body1:'Nhóm một',body2:'Nhóm hai',draft1:'Bản đầu',draft2:'Bản tự viết'};
 return {db,pool,service,activity,classRef:c.public_id,studentRef,sessionRef:session.sessionRef,snapshot};
}
export async function queue(x,section='overview'){
 if(section==='draft'){
  await x.pool.query("UPDATE writing_practice.session_section SET locked=true WHERE section_key IN ('overview','outline') AND session_id=(SELECT id FROM writing_practice.activity_session WHERE public_id=$1)",[x.sessionRef]);
  await x.service.saveDraft({sessionRef:x.sessionRef,baseVersion:0,requestId:randomUUID(),...x.snapshot,draft2Unlocked:true});
 }
 return x.service.submitCheck({sessionRef:x.sessionRef,section,requestId:randomUUID(),snapshot:x.snapshot});
}
export const modelResponse=text=>({ok:true,json:async()=>({candidates:[{finishReason:'STOP',content:{parts:[{text}]}}],modelVersion:'fixture-model'})});
