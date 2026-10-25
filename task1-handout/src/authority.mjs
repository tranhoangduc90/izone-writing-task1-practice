import {Pool} from 'pg';
export function createAuthority(url,pool){
 if(!url)return null;
 const db=new Pool({connectionString:url,max:2,connectionTimeoutMillis:4000,query_timeout:5000});
 return {
  async reviewer(id){
   const r=await db.query('SELECT * FROM task1_bridge.identity_grant($1,$2)',[id.email.toLowerCase(),id.sub]);
   if(!r.rowCount)return null;const a=r.rows[0];
   const classes=await pool.query('SELECT public_id FROM writing_practice.activity_class_scope WHERE $1 OR erp_course_class_id=ANY($2::bigint[])',[a.can_access_all_classes,a.class_ids]);
   return {email:id.email.toLowerCase(),role:a.role,canManage:a.role==='admin',canAccessAllClasses:a.can_access_all_classes,class_refs:classes.rows.map(x=>x.public_id)};
  },
  async search(query,exclude){return (await db.query('SELECT * FROM task1_bridge.search_official_students($1,$2,20)',[query,exclude||null])).rows.map(x=>({studentRef:x.student_public_id,displayName:x.display_name,classNames:x.class_names}));},
  async remember(student){
   const r=await db.query('SELECT * FROM task1_bridge.resolve_official_student($1)',[student]);if(!r.rowCount)return false;
   const x=r.rows[0];await pool.query('INSERT INTO task1_private.official_student VALUES($1,$2,$3) ON CONFLICT(student_public_id) DO UPDATE SET erp_student_contact_id=$2,display_name=$3',[x.student_public_id,x.erp_student_contact_id,x.display_name]);return true;
  }
 };
}
