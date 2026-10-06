import { randomUUID } from 'node:crypto';
import {auditChange,createAudit} from './audit.mjs';

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
        await tx.query('UPDATE handout67.session SET payload=$2::jsonb, updated_at=now() WHERE ref=$1', [ref,JSON.stringify(session)]);
        await auditChange(tx,before,session,clock());
        return answer;
      });
    },
    async findJob(ref) {
      const result=await db.query("SELECT payload FROM handout67.session WHERE payload->'jobs' @> $1::jsonb",[JSON.stringify([{jobRef:ref}])]);
      return result.rows.flatMap(row=>row.payload.jobs).find(job=>job.jobRef===ref);
    },
    async queue(change) {
      return db.transaction(async tx => {
        // Một khóa riêng cho hàng của sản phẩm: hai consumer không cùng vượt trần lease.
        await tx.query('SELECT id FROM handout67.queue_lock WHERE id=1 FOR UPDATE');
        const result = await tx.query("SELECT ref,payload FROM handout67.session WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(payload->'jobs') job WHERE job->>'status' IN ('queued','leased')) ORDER BY updated_at,ref FOR UPDATE");
        const originals = new Map(result.rows.map(row=>[row.ref,JSON.stringify(row.payload)]));
        const sessions = result.rows.map(row => row.payload);
        const answer = await change(sessions);
        for (const session of sessions) {
          if(JSON.stringify(session)===originals.get(session.ref))continue;
          await tx.query('UPDATE handout67.session SET payload=$2::jsonb, updated_at=now() WHERE ref=$1', [session.ref,JSON.stringify(session)]);
          await auditChange(tx,JSON.parse(originals.get(session.ref)),session,clock());
        }
        return answer;
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
