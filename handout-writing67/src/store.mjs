import { randomUUID } from 'node:crypto';
import {auditChange,createAudit} from './audit.mjs';
import {markDashboardActivity} from './dashboard.mjs';

// Chỉ đọc thông tin nhỏ để chọn việc; không chuyển cả bài/prompt của mọi học viên về ứng dụng.
const queueMetadata=`WITH queue_metadata AS MATERIALIZED (
 SELECT s.ref,s.updated_at,j->>'status' AS status,
  COALESCE((j->>'deadlineAt')::bigint,(j->>'createdAt')::bigint+$2::bigint) AS deadline,
  COALESCE((j->>'leaseUntil')::bigint,0) AS lease_until,
  COALESCE((j->>'nextAttemptAt')::bigint,0) AS next_attempt,
  COALESCE((j->>'tries')::integer,0) AS tries,
  (j->'prompt' IS NOT NULL AND j->'prompt' NOT IN ('null'::jsonb,'false'::jsonb,'0'::jsonb,'""'::jsonb)) AS has_prompt
 FROM handout67.session s CROSS JOIN LATERAL jsonb_array_elements(s.payload->'jobs') j
 WHERE j->>'status' IN ('queued','leased')
)`;
const due="status='queued' AND has_prompt AND tries<3 AND deadline>$1::bigint AND next_attempt<=$1::bigint";
const selectedQueue=`${queueMetadata}, first_due AS (
 SELECT ref FROM queue_metadata WHERE ${due} ORDER BY updated_at,ref LIMIT 1
), needed AS (
 SELECT ref FROM queue_metadata WHERE deadline<=$1::bigint
  OR (status='leased' AND lease_until<=$1::bigint)
  OR (status='queued' AND (tries>=3 OR NOT has_prompt))
 UNION SELECT ref FROM first_due
)
SELECT s.ref,s.payload FROM handout67.session s JOIN needed USING(ref)
ORDER BY s.updated_at,s.ref FOR UPDATE OF s`;
const fullQueue="SELECT ref,payload FROM handout67.session WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'jobs') job WHERE job->>'status' IN ('queued','leased')) ORDER BY updated_at,ref FOR UPDATE";

// Nhận adapter PostgreSQL có transaction; lưu/đọc lại đúng phiên, khóa trước thay đổi.
// Không biết hoặc truy cập bảng của sản phẩm khác. Lỗi SQL trả về caller, không giả thành công.
export function createStore(db,{clock=Date.now}={}) {
  return {
    audit:createAudit(db),
    async open(identity, initial) {
      return db.transaction(async tx => {
        const ref = randomUUID();
        const inserted=await tx.query('INSERT INTO handout67.session (ref, identity_key, payload) VALUES ($1,$2,$3::jsonb) ON CONFLICT (identity_key) DO NOTHING RETURNING ref', [ref,identity,JSON.stringify(initial(ref))]);
        const result = await tx.query('SELECT payload FROM handout67.session WHERE identity_key=$1', [identity]);
        if(inserted.rows.length)await auditChange(tx,null,result.rows[0].payload,clock());
        return result.rows[0].payload;
      });
    },
    async read(ref) {
      const result = await db.query('SELECT payload FROM handout67.session WHERE ref=$1', [ref]);
      return result.rows[0]?.payload;
    },
    async edit(ref, change) {
      return db.transaction(async tx => {
        const result = await tx.query('SELECT payload FROM handout67.session WHERE ref=$1 FOR UPDATE', [ref]);
        if (!result.rows[0]) return undefined;
        const session = result.rows[0].payload;
        const before=structuredClone(session);
        const answer = await change(session);
        if(JSON.stringify(before)===JSON.stringify(session))return answer;
        markDashboardActivity(before,session,clock());
        await tx.query('UPDATE handout67.session SET payload=$2::jsonb, updated_at=now() WHERE ref=$1', [ref,JSON.stringify(session)]);
        await auditChange(tx,before,session,clock());
        return answer;
      });
    },
    async findJob(ref,sessionRef) {
      // Envelope đã có mã phiên: tìm bằng khóa chính, không đọc bài của cả lớp cho mỗi phản hồi.
      // Hint sai/thiếu vẫn đi đường cũ để caller giữ nguyên kiểm định danh và mã lỗi.
      if(typeof sessionRef==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sessionRef)){
        const result=await db.query('SELECT payload FROM handout67.session WHERE ref=$1',[sessionRef]);
        const job=result.rows[0]?.payload.jobs.find(job=>job.jobRef===ref);
        if(job)return job;
      }
      const result=await db.query("SELECT payload FROM handout67.session WHERE payload->'jobs' @> $1::jsonb",[JSON.stringify([{jobRef:ref}])]);
      return result.rows.flatMap(row=>row.payload.jobs).find(job=>job.jobRef===ref);
    },
    async queue(change,select=null) {
      return db.transaction(async tx => {
        // Một khóa riêng cho hàng của sản phẩm: hai consumer không cùng vượt trần lease.
        await tx.query('SELECT id FROM handout67.queue_lock WHERE id=1 FOR UPDATE');
        // Chụp giờ sau khi có khóa. Sweep cũ vẫn đọc đủ; claim dùng đúng phiên cần đổi.
        const scope=typeof select==='function'?select():null;
        for(let pass=0;;pass++){
          const args=scope?[scope.now,scope.maxJobMs]:[];
          const activeLeases=scope&&scope.maxLeases!==null?(await tx.query(`${queueMetadata} SELECT count(*)::int AS n FROM queue_metadata WHERE status='leased' AND lease_until>$1::bigint AND deadline>$1::bigint`,args)).rows[0].n:0;
          const result = await tx.query(scope&&pass<16?selectedQueue:fullQueue,scope&&pass<16?args:[]);
          const originals = new Map(result.rows.map(row=>[row.ref,JSON.stringify(row.payload)]));
          const sessions = result.rows.map(row => row.payload);
          const answer = await change(sessions,scope?{now:scope.now,activeLeases}:undefined);
          for (const session of sessions) {
            if(JSON.stringify(session)===originals.get(session.ref))continue;
            markDashboardActivity(JSON.parse(originals.get(session.ref)),session,clock());
            await tx.query('UPDATE handout67.session SET payload=$2::jsonb, updated_at=now() WHERE ref=$1', [session.ref,JSON.stringify(session)]);
            await auditChange(tx,JSON.parse(originals.get(session.ref)),session,clock());
          }
          if(!scope||!Array.isArray(answer)||answer.length||pass>=16||(scope.maxLeases!==null&&activeLeases>=scope.maxLeases))return answer;
          // Nếu người dùng đổi bài trong lúc chờ khóa dòng, chọn lại; không báo hàng rỗng giả.
          const pending=await tx.query(`${queueMetadata} SELECT EXISTS(SELECT 1 FROM queue_metadata WHERE ${due}) AS waiting`,args);
          if(!pending.rows[0].waiting)return answer;
        }
      });
    }
  };
}

export function postgresAdapter(pool) {
  return {
    query: (sql, args) => pool.query(sql, args),
    async transaction(change) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await change(client);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally { client.release(); }
    }
  };
}
