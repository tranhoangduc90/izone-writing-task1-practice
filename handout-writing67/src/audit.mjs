import {createHash} from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const iso=ms=>new Date(ms).toISOString();
const terminal=status=>['completed','failed'].includes(status);
// SQL tính tháng lịch trong UTC, không lấy 60 ngày hoặc phụ thuộc timezone của connection.
const expiry="((($1::timestamptz AT TIME ZONE 'UTC') + interval '2 months') AT TIME ZONE 'UTC')";

// Nhận trạng thái trước/sau transaction; chỉ ghi sự kiện chuyển trạng thái có ích.
// Lỗi SQL làm toàn bộ thay đổi rollback; không ACK giả. Không ghi token hay leaseToken.
export async function auditChange(tx,before,after,now){
  async function event(key,kind,job=null,details={}){
    await tx.query(`INSERT INTO handout67.activity_event(event_key,session_ref,class_ref,student_ref,job_ref,attempt_index,section,idea_index,kind,event_at,expires_at,details)
      VALUES($2,$3,$4,$5,$6,$7,$8,$9,$10,$1::timestamptz,CASE WHEN $6::uuid IS NULL THEN ${expiry} ELSE NULL END,$11::jsonb)
      ON CONFLICT(event_key) DO NOTHING`,[iso(now),key,after.ref,after.classRef,after.studentRef,job?.jobRef??null,job?.tries||null,job?.section??null,job?.ideaIndex??null,kind,JSON.stringify(details)]);
  }
  if(!before)await event(`${after.ref}:open`,'session_opened');
  if(before&&JSON.stringify(before.responses)!==JSON.stringify(after.responses)){
    const fields=Object.keys(after.responses).filter(k=>before.responses[k]!==after.responses[k]);
    await event(`${after.ref}:save:${after.version}`,'responses_saved',null,{version:after.version,fields});
  }
  if(before&&!before.idea2Open&&after.idea2Open)await event(`${after.ref}:idea2`,'idea2_opened');
  const oldComments=new Set((before?.teacherComments||[]).map(c=>c.ref));
  for(const c of after.teacherComments||[])if(!oldComments.has(c.ref))await event(`${after.ref}:teacher:${c.ref}`,'teacher_comment',null,{section:c.section,commentRef:c.ref,authorName:c.authorName});
  const oldJobs=new Map((before?.jobs||[]).map(j=>[j.jobRef,j]));
  for(const job of after.jobs){
    const old=oldJobs.get(job.jobRef);
    const input=job.snapshot?job:old;
    if((!old||old.status!==job.status||old.tries!==job.tries)&&input?.snapshot){
      await tx.query(`INSERT INTO handout67.grading_input(job_ref,session_ref,class_ref,student_ref,section,idea_index,kind,snapshot_hash,snapshot,prompt,prompt_version,operation_key,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12,$13::timestamptz) ON CONFLICT(job_ref) DO NOTHING`,[job.jobRef,after.ref,after.classRef,after.studentRef,job.section,job.ideaIndex,job.kind,job.snapshotHash,JSON.stringify(input.snapshot),input.prompt??null,job.promptVersion,job.operationKey,iso(job.createdAt)]);
    }
    if(!old){
      await event(`${job.jobRef}:queued`,'check_queued',job,{kind:job.kind,snapshotHash:job.snapshotHash});
    }
    if(job.tries>0&&job.tries!==(old?.tries||0)){
      if(old?.status==='leased'&&old.tries>0)await tx.query("UPDATE handout67.grading_attempt SET status='timed_out',error_code='ATTEMPT_TIMEOUT',finished_at=$3::timestamptz WHERE job_ref=$1 AND attempt_index=$2",[job.jobRef,old.tries,iso(now)]);
      const attempt=job.attempts?.find(a=>a.number===job.tries);
      if(!attempt)throw new Error('ATTEMPT_IDENTITY_MISSING');
      await tx.query(`INSERT INTO handout67.grading_attempt(job_ref,attempt_index,attempt_ref,started_at,status)
        VALUES($1,$2,$3,$4::timestamptz,'processing') ON CONFLICT(job_ref,attempt_index) DO NOTHING`,[job.jobRef,job.tries,attempt.ref,iso(now)]);
      await event(`${job.jobRef}:claim:${job.tries}`,'processing_started',job,{attemptRef:attempt.ref});
    }
    if(old?.status!==job.status&&old){
      await event(`${job.jobRef}:state:${job.tries}:${job.status}`,'job_'+job.status,job,{error:job.error??null});
      if(job.status!=='leased'&&job.tries>0)await tx.query('UPDATE handout67.grading_attempt SET status=$3,error_code=$4,finished_at=$5::timestamptz WHERE job_ref=$1 AND attempt_index=$2',[job.jobRef,job.tries,job.status,job.error??null,iso(now)]);
    }
    if(terminal(job.status)&&!terminal(old?.status)){
      const until=await tx.query(`SELECT ${expiry} AS expires_at`,[iso(now)]);
      const expires=until.rows[0].expires_at;
      await tx.query('UPDATE handout67.grading_input SET expires_at=$2 WHERE job_ref=$1',[job.jobRef,expires]);
      await tx.query('UPDATE handout67.grading_attempt SET expires_at=$2 WHERE job_ref=$1',[job.jobRef,expires]);
      await tx.query('UPDATE handout67.activity_event SET expires_at=$2 WHERE job_ref=$1',[job.jobRef,expires]);
    }
  }
}

// Nhận phản hồi AI đã xác thực attempt; lưu nguyên dạng trước bước parse/validate.
// Replay nguyên phản hồi giữ một bản; phản hồi khác cùng attempt bị chặn, không ghi đè evidence.
export function createAudit(db){
  return {
    async capture(job,attempt,body,now){
      if(typeof body.outputText!=='string'||Buffer.byteLength(body.outputText)>262144)throw Object.assign(new Error('AI_RESPONSE_TOO_LARGE'),{status:413});
      const digest=hash(body.outputText);
      return db.transaction(async tx=>{
        const current=await tx.query('SELECT response_hash FROM handout67.grading_attempt WHERE job_ref=$1 AND attempt_index=$2 FOR UPDATE',[job.jobRef,attempt.number]);
        if(!current.rows.length)throw Object.assign(new Error('ATTEMPT_NOT_FOUND'),{status:404});
        if(current.rows[0].response_hash&&current.rows[0].response_hash!==digest)throw Object.assign(new Error('AI_RESPONSE_CONFLICT'),{status:409});
        if(current.rows[0].response_hash)return {responseHash:digest,replayed:true};
        await tx.query(`UPDATE handout67.grading_attempt SET response_text=$3,response_body=$4::jsonb,response_hash=$5,
          model=$6,http_status=$7,execution_ref=$8,provider_ref=$9,
          status=CASE WHEN status='processing' THEN 'response_received' ELSE status END,
          error_code=COALESCE(error_code,$10)
          WHERE job_ref=$1 AND attempt_index=$2`,[job.jobRef,attempt.number,body.outputText,body.responseBody===undefined?null:JSON.stringify(body.responseBody),digest,typeof body.model==='string'?body.model.slice(0,200):null,Number.isInteger(body.httpStatus)?body.httpStatus:null,typeof body.executionRef==='string'?body.executionRef.slice(0,128):null,typeof body.providerRef==='string'?body.providerRef.slice(0,128):null,body.transportError??null]);
        await tx.query(`INSERT INTO handout67.activity_event(event_key,session_ref,class_ref,student_ref,job_ref,attempt_index,section,idea_index,kind,event_at,expires_at,details)
          SELECT $1,session_ref,class_ref,student_ref,job_ref,$2,section,idea_index,'ai_response_received',$3::timestamptz,expires_at,$4::jsonb FROM handout67.grading_input WHERE job_ref=$5
          ON CONFLICT(event_key) DO NOTHING`,[`${job.jobRef}:response:${attempt.number}`,attempt.number,iso(now),JSON.stringify({responseHash:digest,receivedBytes:Buffer.byteLength(body.outputText)}),job.jobRef]);
        return {responseHash:digest,replayed:false};
      });
    },
    async response(jobRef,attemptRef){
      const found=await db.query('SELECT response_text,response_body,model,http_status,execution_ref,provider_ref,error_code FROM handout67.grading_attempt WHERE job_ref=$1 AND attempt_ref=$2 AND response_hash IS NOT NULL',[jobRef,attemptRef]);
      const r=found.rows[0];
      return r?{outputText:r.response_text,responseBody:r.response_body,model:r.model,httpStatus:r.http_status,executionRef:r.execution_ref,providerRef:r.provider_ref,transportError:r.error_code}:null;
    },
    async read(sessionRef,{limit=100,before=null,jobRef=null}={}){
      if(!Number.isInteger(limit)||limit<1||limit>100)throw Object.assign(new Error('LOG_QUERY_INVALID'),{status:400});
      let cursor=null;
      if(before){
        try{cursor=JSON.parse(Buffer.from(before,'base64url').toString('utf8'));}catch{throw Object.assign(new Error('LOG_QUERY_INVALID'),{status:400});}
        if(!Array.isArray(cursor)||cursor.length!==2||typeof cursor[0]!=='string'||!/(Z|[+-]\d{2}:\d{2})$/.test(cursor[0])||!Number.isFinite(Date.parse(cursor[0]))||typeof cursor[1]!=='string')throw Object.assign(new Error('LOG_QUERY_INVALID'),{status:400});
      }
      if(jobRef&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobRef))throw Object.assign(new Error('LOG_QUERY_INVALID'),{status:400});
      const events=await db.query(`SELECT event_key,kind,event_at,expires_at,job_ref,attempt_index,section,idea_index,details
        FROM handout67.activity_event WHERE session_ref=$1 AND ($2::timestamptz IS NULL OR (event_at,event_key)<($2::timestamptz,$3::text))
        ORDER BY event_at DESC,event_key DESC LIMIT $4`,[sessionRef,cursor?.[0]??null,cursor?.[1]??null,limit+1]);
      const page=events.rows.slice(0,limit),last=page.at(-1);
      const nextCursor=events.rows.length>limit?Buffer.from(JSON.stringify([last.event_at.toISOString(),last.event_key])).toString('base64url'):null;
      let detail=null;
      if(jobRef){
        const input=await db.query(`SELECT job_ref,section,idea_index,kind,snapshot_hash,snapshot,prompt_version,operation_key,created_at,expires_at
          FROM handout67.grading_input WHERE session_ref=$1 AND job_ref=$2`,[sessionRef,jobRef]);
        const attempts=await db.query(`SELECT a.* FROM handout67.grading_attempt a JOIN handout67.grading_input i ON i.job_ref=a.job_ref
          WHERE i.session_ref=$1 AND i.job_ref=$2 ORDER BY a.attempt_index`,[sessionRef,jobRef]);
        if(input.rows.length)detail={input:input.rows[0],attempts:attempts.rows};
      }
      return {events:page,nextCursor,detail};
    },
    async cleanup(now,limit=100){const r=await db.query('SELECT handout67.cleanup_activity_log($1::timestamptz,$2) AS removed',[iso(now),limit]);return r.rows[0].removed;}
  };
}
