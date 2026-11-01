/** Đọc gộp trạng thái và phiên đang được theo dõi; không trả đáp án/token ra stream. */
export const observationKey=s=>JSON.stringify([s.ownerId,s.courseId,s.code,s.version,s.attemptId||null]);
export const documentKey=d=>JSON.stringify([d.code,d.version,d.documentId]);

export async function readWebObservations(db,{scopes,guards,documents,now=new Date().toISOString()}){
  const unique=new Map(scopes.map(s=>[observationKey(s),{...s,key:observationKey(s),attemptId:s.attemptId||null}]));
  const states=async()=>{
    if(!unique.size)return [];
    return (await db.query(`WITH scopes AS (
      SELECT * FROM jsonb_to_recordset($1::jsonb) AS s(key text,"ownerId" text,"courseId" text,code text,version text,"attemptId" uuid)
    ) SELECT s.key,d.revision AS "draftRevision",d.run_no AS "runNo",a.id AS "attemptId",j.status,j.error_code AS "errorCode",
      md5(COALESCE(r.data::text,'')) AS "resultRevision",md5(COALESCE(v.state::text,'')||COALESCE(v.next_attempt_at::text,'')) AS "validationRevision",
      v.state->>'phase' AS phase,v.state->>'round' AS round,
      (SELECT md5(COALESCE(jsonb_agg(jsonb_build_array(e.id,e.data) ORDER BY e.created_at,e.id)::text,''))
       FROM reading_listening67.web_validation_event e WHERE e.job_id=j.id AND e.kind='recovery_started') AS "recoveryRevision",
      b.id AS "bindingId",b.sequence AS "documentSequence",b.last_doc_sequence AS "documentVerifiedSequence",b.target IS NOT NULL AS "hasDocumentTarget",COALESCE(h.jobs,'[]'::jsonb) AS jobs,
      s."attemptId" IS NOT NULL AND a.id IS NULL AS "attemptMissing"
    FROM scopes s
    LEFT JOIN reading_listening67.web_draft d ON d.owner_id=s."ownerId" AND d.course_id=s."courseId" AND d.assignment_code=s.code AND d.content_version=s.version
    LEFT JOIN LATERAL (SELECT x.id FROM reading_listening67.web_attempt x
      WHERE x.owner_id=s."ownerId" AND x.course_id=s."courseId" AND x.assignment_code=s.code AND x.content_version=s.version
        AND (s."attemptId" IS NULL OR x.id=s."attemptId") ORDER BY x.created_at DESC,x.id DESC LIMIT 1) a ON true
    LEFT JOIN reading_listening67.web_job j ON j.attempt_id=a.id
    LEFT JOIN reading_listening67.web_result r ON r.attempt_id=a.id
    LEFT JOIN reading_listening67.web_validation v ON v.job_id=j.id
    LEFT JOIN reading_listening67.web_homework_binding b ON b.owner_id=s."ownerId" AND b.course_id=s."courseId" AND b.assignment_code=s.code AND b.content_version=s.version
    LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',x.id,'sequence',x.sequence,'kind',x.kind,'status',x.status,'errorCode',x.error_code,'verifiedAt',x.verified_at) ORDER BY x.sequence) AS jobs
      FROM reading_listening67.web_homework_job x WHERE x.binding_id=b.id AND (
        x.sequence IN (0,b.sequence)
        OR x.id=(SELECT p.id FROM reading_listening67.web_homework_job p WHERE p.binding_id=b.id AND p.status<>'verified' ORDER BY p.sequence LIMIT 1)
        OR x.id=(SELECT p.id FROM reading_listening67.web_homework_job p WHERE p.binding_id=b.id AND p.status='blocked' ORDER BY p.sequence LIMIT 1)
      )) h ON true`,[JSON.stringify([...unique.values()])])).rows;
  };
  const sessions=async()=>{
    const students=[...new Set(guards.filter(g=>g.kind==='student').map(g=>g.hash))],teachers=[...new Set(guards.filter(g=>g.kind==='teacher').map(g=>g.hash))];
    if(!students.length&&!teachers.length)return [];
    return (await db.query(`SELECT 'student' AS kind,token_hash AS hash,to_jsonb(s) AS value FROM reading_listening67.web_student_session s WHERE token_hash=ANY($1::text[]) AND expires_at>$3::timestamptz
      UNION ALL SELECT 'teacher' AS kind,token_hash AS hash,to_jsonb(t) AS value FROM reading_listening67.web_teacher_session t WHERE token_hash=ANY($2::text[]) AND expires_at>$3::timestamptz AND absolute_expires_at>$3::timestamptz`,[students,teachers,now])).rows;
  };
  const bindings=async()=>{
    const input=[...new Map(documents.map(d=>[documentKey(d),{...d,key:documentKey(d)}])).values()];
    if(!input.length)return [];
    return (await db.query(`WITH docs AS (SELECT * FROM jsonb_to_recordset($1::jsonb) AS d(key text,code text,version text,"documentId" text))
      SELECT d.key,COALESCE(jsonb_agg(to_jsonb(b)) FILTER(WHERE b.id IS NOT NULL),'[]'::jsonb) AS rows FROM docs d
      LEFT JOIN reading_listening67.web_homework_binding b ON b.assignment_code=d.code AND b.content_version=d.version AND b.target->>'documentId'=d."documentId" GROUP BY d.key`,[JSON.stringify(input)])).rows;
  };
  const [stateRows,sessionRows,bindingRows]=await Promise.all([states(),sessions(),bindings()]);
  return {states:new Map(stateRows.map(({key,...value})=>[key,value])),sessions:new Map(sessionRows.map(r=>[r.kind+':'+r.hash,r.value])),documents:new Map(bindingRows.map(r=>[r.key,r.rows]))};
}
