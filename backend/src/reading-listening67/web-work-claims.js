/**
 * Nhận các bài đang rảnh, khóa tối đa một việc mỗi bài trong cùng câu SQL.
 * Giữ điều kiện đến hạn, thứ tự Docs và lease của kho cũ; không gọi AI/Google.
 * Chỉ trả việc đã khóa cho đúng bài. Việc chưa giao được trả lại bằng lease riêng.
 */
import {randomUUID} from 'node:crypto';

export function gradingWorkView(job,attempt){
  return {jobId:job.id,attemptId:attempt.id,leaseToken:job.lease_token,answers:attempt.snapshot.answers,inputHash:attempt.input_hash,graderHash:attempt.grader_hash,ownerId:attempt.owner_id,replayResponse:job.provider_response};
}

export function homeworkWorkView(job){return {...job,leaseId:job.lease_id};}

const scopeSql=`SELECT code,version,validation,token FROM jsonb_to_recordset($1::jsonb)
  AS s(code text,version text,validation boolean,token uuid)`;

export async function claimWebWorkBatch(db,lane,scopes){
  if(!scopes.length)return [];
  if(!['grading','docs'].includes(lane))throw Error('WORK_LANE_INVALID');
  const seen=new Set();
  const input=scopes.map(scope=>{
    const key=JSON.stringify([scope.code,scope.version]);
    if(!scope.code||!scope.version||seen.has(key))throw Error('WORK_SCOPE_INVALID');
    seen.add(key);return {code:scope.code,version:scope.version,validation:!!scope.validation,token:randomUUID()};
  });
  let sql;
  if(lane==='grading'){
    sql=`WITH scopes AS (${scopeSql}), picked AS MATERIALIZED (
      SELECT s.code,s.version,s.token,p.id FROM scopes s CROSS JOIN LATERAL (
        SELECT j.id FROM reading_listening67.web_job j
        JOIN reading_listening67.web_attempt a ON a.id=j.attempt_id
        LEFT JOIN reading_listening67.web_validation v ON v.job_id=j.id
        WHERE a.assignment_code=s.code AND a.content_version=s.version AND j.status='queued'
          AND (NOT s.validation OR v.next_attempt_at IS NULL OR v.next_attempt_at<=now())
        ORDER BY CASE WHEN s.validation THEN COALESCE(v.next_attempt_at,j.created_at) ELSE j.created_at END,j.id
        FOR UPDATE OF j SKIP LOCKED LIMIT 1
      ) p
    ), claimed AS (
      UPDATE reading_listening67.web_job j SET status='processing',lease_token=p.token,lease_until=now()+interval '15 minutes'
      FROM picked p WHERE j.id=p.id RETURNING j.*,p.code,p.version
    ) SELECT c.*,a.snapshot,a.input_hash,a.grader_hash,a.owner_id FROM claimed c
      JOIN reading_listening67.web_attempt a ON a.id=c.attempt_id`;
  }else{
    sql=`WITH scopes AS (${scopeSql}), picked AS MATERIALIZED (
      SELECT s.code,s.version,s.token,p.id FROM scopes s CROSS JOIN LATERAL (
        SELECT j.id FROM reading_listening67.web_homework_job j
        JOIN reading_listening67.web_homework_binding b ON b.id=j.binding_id
        WHERE b.assignment_code=s.code AND b.content_version=s.version
          AND ((j.status='pending' AND j.available_at<=now()) OR (j.status='processing' AND j.lease_until<now()))
          AND NOT EXISTS(SELECT 1 FROM reading_listening67.web_homework_job old
            WHERE old.binding_id=j.binding_id AND old.sequence<j.sequence AND old.status<>'verified')
        ORDER BY j.created_at,j.sequence,j.id FOR UPDATE OF j SKIP LOCKED LIMIT 1
      ) p
    ) UPDATE reading_listening67.web_homework_job j SET status='processing',lease_id=p.token,
        lease_until=now()+interval '180 seconds',attempts=attempts+1
      FROM picked p WHERE j.id=p.id RETURNING j.*,p.code,p.version`;
  }
  return (await db.query(sql,[JSON.stringify(input)])).rows.map(row=>({
    code:row.code,version:row.version,
    job:lane==='grading'?gradingWorkView(row,{...row,id:row.attempt_id}):homeworkWorkView(row)
  }));
}

export async function releaseUnstartedWebWork(db,lane,items){
  if(!items.length)return;
  if(!['grading','docs'].includes(lane))throw Error('WORK_LANE_INVALID');
  const claims=items.map(({job})=>({id:lane==='grading'?job.jobId:job.id,token:lane==='grading'?job.leaseToken:job.leaseId}));
  const sources=`jsonb_to_recordset($1::jsonb) AS c(id uuid,token uuid)`;
  if(lane==='grading')await db.query(`UPDATE reading_listening67.web_job j SET status='queued',lease_token=NULL,lease_until=NULL
    FROM ${sources} WHERE j.id=c.id AND j.lease_token=c.token AND j.status='processing'`,[JSON.stringify(claims)]);
  else await db.query(`UPDATE reading_listening67.web_homework_job j SET status='pending',lease_id=NULL,lease_until=NULL,
      attempts=GREATEST(0,attempts-1),available_at=now()
    FROM ${sources} WHERE j.id=c.id AND j.lease_id=c.token AND j.status='processing'`,[JSON.stringify(claims)]);
}
