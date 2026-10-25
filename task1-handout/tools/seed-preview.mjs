import fs from 'node:fs/promises';
import {Pool} from 'pg';
import {randomUUID,createHash} from 'node:crypto';
const url=new URL(process.env.TASK1_OWNER_DATABASE_URL||'');if(url.username!=='task1_owner'||url.pathname!=='/sw_task1')throw Error('TASK1_PREVIEW_DATABASE_REQUIRED');
const input=JSON.parse(await fs.readFile(process.env.TASK1_PREVIEW_SEED_FILE,'utf8')),pool=new Pool({connectionString:url.href,max:1});
try{
 await pool.query('BEGIN');
 for(const a of input.activities){
  await pool.query(`INSERT INTO writing_practice.activity(public_id,slug,content_version,manifest_checksum,title,task_prompt,prompt_record_ref,prompt_version,status,end_date) VALUES($1,$2,'preview-20261025',$3,$4,$5,'task1-preview',$6,'active','2030-12-31') ON CONFLICT(slug,content_version) DO NOTHING`,[a.public_id,a.slug,a.manifest_checksum,a.title,a.task_prompt,input.promptVersion]);
  const activity=(await pool.query("SELECT id FROM writing_practice.activity WHERE slug=$1 AND content_version='preview-20261025'",[a.slug])).rows[0];
  for(const [i,name] of ['TASK1-THU-A','TASK1-THU-B'].entries()){
   await pool.query("INSERT INTO writing_practice.activity_class_scope(activity_id,erp_course_class_id,class_name_snapshot,end_date) VALUES($1,$2,$3,'2030-12-31') ON CONFLICT DO NOTHING",[activity.id,999901+i,name]);
   const scope=(await pool.query('SELECT id FROM writing_practice.activity_class_scope WHERE activity_id=$1 AND erp_course_class_id=$2',[activity.id,999901+i])).rows[0];
   const existing=(await pool.query('SELECT count(*)::int n FROM writing_practice.activity_roster WHERE activity_class_id=$1',[scope.id])).rows[0].n;
   if(!existing)for(let j=1;j<=2;j++)await pool.query('INSERT INTO writing_practice.activity_roster(activity_class_id,student_public_id,display_name,display_alias) VALUES($1,$2,$3,$3)',[scope.id,randomUUID(),`Học viên thử ${j}`]);
  }
 }
 const r=input.reviewer;if(r.status!=='active'||r.role!=='admin'||!r.google_subject)throw Error('EXISTING_REVIEWER_REQUIRED');
 await pool.query("INSERT INTO task1_private.teacher_grant(email,google_subject,role,active) VALUES($1,$2,'admin',true) ON CONFLICT DO NOTHING",[r.email,r.google_subject]);
 await pool.query('COMMIT');console.log(JSON.stringify({outcome:'success',activities:input.activities.length,fixtureClasses:12,sourceReviewerRolePreserved:r.role}));
}catch(e){await pool.query('ROLLBACK');throw e;}finally{await pool.end();}
