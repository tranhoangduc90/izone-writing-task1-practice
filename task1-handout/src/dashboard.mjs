const fields=['overview','body1','body2','draft1','draft2'];
export function dashboardStudent(row){
 const responses=row.responses||{},sections=Object.entries(row.sections||{});
 return {...row,totalFields:fields.length,savedAt:row.savedAt||row.updatedAt||null,
  hasStarted:Boolean(row.filledFields||row.checkCount),
  attemptedSectionCount:sections.filter(([,s])=>s.status!=='draft').length,
  supportSections:sections.filter(([,s])=>s.failStreak>=3).map(([section,s])=>({section,commentNumber:s.failStreak,warningAt:row.savedAt||row.updatedAt}))};
}
export async function dashboard({pool,service,slug,classRef,reviewer}){
 const data=await pool.query(`SELECT c.public_id AS "classRef",c.class_name_snapshot AS "className",r.student_public_id AS "studentRef",r.display_alias AS "displayName",s.public_id AS "sessionRef",s.updated_at AS "updatedAt",p.status AS "provisionalStatus" FROM writing_practice.activity a JOIN writing_practice.activity_class_scope c ON c.activity_id=a.id JOIN writing_practice.activity_roster r ON r.activity_class_id=c.id AND r.active LEFT JOIN writing_practice.activity_session s ON s.activity_class_id=c.id AND s.student_public_id=r.student_public_id LEFT JOIN writing_practice.provisional_student p ON p.activity_class_id=c.id AND p.student_public_id=r.student_public_id WHERE a.slug=$1 AND c.status='active' AND ($2::uuid IS NULL OR c.public_id=$2) AND ($3 OR c.public_id=ANY($4::uuid[])) ORDER BY c.class_name_snapshot,r.display_alias`,[slug,classRef,reviewer.canManage,reviewer.class_refs]);
 const presence=await pool.query('SELECT public_id,last_seen_at FROM writing_practice.activity_session WHERE public_id=ANY($1::uuid[])',[data.rows.map(x=>x.sessionRef).filter(Boolean)]);
 const online=new Set(presence.rows.filter(x=>Date.now()-Date.parse(x.last_seen_at)<70000).map(x=>x.public_id));
 for(const row of data.rows)row.online=online.has(row.sessionRef);
 const students=[];
 for(const row of data.rows){
  const s=row.sessionRef?await service.sessionDetails(row.sessionRef):null,responses=Object.fromEntries(fields.map(k=>[k,s?.[k]||''])),filledFields=Object.values(responses).filter(x=>x.trim()).length;
  students.push({...row,responses,sections:s?.sections||{},draftVersion:s?.draftVersion||0,savedAt:row.updatedAt,liveAt:row.updatedAt,progressPercent:Math.round(filledFields/5*100),filledFields,fieldCount:5,sectionCount:3,passedSectionCount:Object.values(s?.sections||{}).filter(x=>x.locked).length,checkCount:s?.attempts.length||0,supportRequired:Object.values(s?.sections||{}).some(x=>x.failStreak>=3),provisional:row.provisionalStatus==='pending',reconciliationStatus:row.provisionalStatus||'official',readOnly:false});
 }
 const h=service.history?await service.history():null;
 const legacy=h?.students(slug).filter(x=>(!classRef||x.classRef===classRef)&&(reviewer.canManage||reviewer.class_refs.includes(x.classRef)))||[];
 return {students:[...students,...legacy].map(dashboardStudent),generatedAt:new Date().toISOString(),permissions:{canManage:false},history:h?.metadata||null};
}
