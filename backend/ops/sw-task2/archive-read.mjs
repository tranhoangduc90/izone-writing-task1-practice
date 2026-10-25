import {ApiError} from '../../src/service.js';
export function createArchiveRead({pool}){
 async function roster(slug,reviewer){
  const rows=await pool.query(`SELECT c.public_id AS "classRef",c.class_name_snapshot AS "className",
   r.student_public_id AS "studentRef",COALESCE(r.display_alias,r.display_name) AS "displayName",
   (p.status='pending') AS "requiresAccessCode"
   FROM writing_practice.activity a JOIN writing_practice.activity_class_scope c ON c.activity_id=a.id
   JOIN writing_practice.sw_preview_scope kind ON kind.scope_id=c.id
   LEFT JOIN writing_practice.activity_roster r ON r.activity_class_id=c.id AND (r.active OR EXISTS(
    SELECT 1 FROM writing_practice.activity_session s WHERE s.activity_class_id=c.id AND s.student_public_id=r.student_public_id))
   LEFT JOIN writing_practice.provisional_student p ON p.activity_class_id=c.id AND p.student_public_id=r.student_public_id
   WHERE a.slug=$1 AND (kind.kind='archive' OR (c.status='active' AND c.end_date>=CURRENT_DATE))
   AND ($2 OR EXISTS(SELECT 1 FROM mapping.reviewer_class_access x WHERE x.reviewer_email=$3 AND x.erp_course_class_id=c.erp_course_class_id))
   ORDER BY c.class_name_snapshot,r.display_alias`,[slug,reviewer.role==='admin',reviewer.email]);
  const classes=new Map();for(const row of rows.rows){if(!classes.has(row.classRef))classes.set(row.classRef,{classRef:row.classRef,className:row.className,students:[]});if(row.studentRef)classes.get(row.classRef).students.push({studentRef:row.studentRef,displayName:row.displayName,requiresAccessCode:row.requiresAccessCode});}
  return {classes:[...classes.values()]};
 }
 async function live(slug,classRef,reviewer){
  const scope=await pool.query(`SELECT c.id,c.erp_course_class_id FROM writing_practice.activity_class_scope c
   JOIN writing_practice.activity a ON a.id=c.activity_id JOIN writing_practice.sw_preview_scope p ON p.scope_id=c.id AND p.kind='archive'
   WHERE a.slug=$1 AND c.public_id=$2`,[slug,classRef]);
  if(!scope.rowCount)return null;
  if(reviewer.role!=='admin'){
   const allowed=await pool.query('SELECT 1 FROM mapping.reviewer_class_access WHERE reviewer_email=$1 AND erp_course_class_id=$2',[reviewer.email,scope.rows[0].erp_course_class_id]);
   if(!allowed.rowCount)throw new ApiError(403,'CLASS_ACCESS_DENIED','Tài khoản chưa có quyền đọc lớp này.');
  }
  const result=await pool.query(`SELECT r.student_public_id AS "studentRef",c.public_id AS "classRef",c.class_name_snapshot AS "className",
   COALESCE(r.display_alias,r.display_name) AS "displayName",s.public_id AS "sessionRef",s.response_data AS responses,
   (SELECT count(*)::int FROM writing_practice.check_attempt a WHERE a.session_id=s.id) AS "checkCount",
   (SELECT count(*)::int FROM writing_practice.session_section x WHERE x.session_id=s.id AND x.locked) AS "passedSectionCount"
   FROM writing_practice.activity_class_scope c JOIN writing_practice.activity_roster r ON r.activity_class_id=c.id
   LEFT JOIN writing_practice.activity_session s ON s.activity_class_id=c.id AND s.student_public_id=r.student_public_id
   WHERE c.id=$1 AND (r.active OR s.id IS NOT NULL) ORDER BY r.display_alias`,[scope.rows[0].id]);
  const defs=await pool.query('SELECT required_fields FROM writing_practice.activity_section_definition WHERE activity_id=(SELECT activity_id FROM writing_practice.activity_class_scope WHERE id=$1)',[scope.rows[0].id]);
  const required=[...new Set(defs.rows.flatMap(d=>d.required_fields))];
  return {ok:true,archiveReadOnly:true,students:result.rows.map(r=>{const filled=required.filter(k=>String(r.responses?.[k]||'').trim()).length;return {...r,filledFields:filled,progressPercent:Math.round(100*filled/Math.max(1,required.length)),supportRequired:false,provisional:false};}),permissions:{canManage:reviewer.role==='admin'}};
 }
 return {roster,live};
}
