import { withTransaction } from './db.js';
import { sha256 } from './writing-flow-crypto.js';

// Nhận vào: số yêu cầu bàn giao tối đa của một lượt quét.
// Việc chính: cấp lại những yêu cầu chưa được bước sau xác nhận, cùng đúng mã cặp/phiên bản.
// Trả ra: danh sách nhỏ để n8n gọi workflow bước sau mà không chờ kết quả chấm.
// Khi gọi workflow lỗi: yêu cầu vẫn còn trong database và sẽ được cấp lại sau 30 giây.
export function createWritingFlowHandoff({ pool }) {
  async function due(limit = 20) {
    return withTransaction(pool, async client => {
      await client.query(`
        UPDATE writing_flow.handoff h SET status='acknowledged', acknowledged_at=now()
        FROM writing_flow.pair p
        WHERE h.pair_id=p.pair_id AND h.status IN ('pending','sent')
          AND p.status IN ('delivered','superseded')`);
      const claimed = await client.query(`
        WITH ready AS (
          SELECT h.handoff_id
            FROM writing_flow.handoff h
            JOIN writing_flow.pair p ON p.pair_id=h.pair_id
           WHERE h.status IN ('pending','sent')
             AND h.next_send_at<=now()
             AND p.status NOT IN ('delivered','superseded')
           ORDER BY h.next_send_at,h.created_at,h.handoff_id
           LIMIT $1 FOR UPDATE OF h SKIP LOCKED
        )
        UPDATE writing_flow.handoff h
           SET status='sent',send_count=h.send_count+1,last_sent_at=now(),
               next_send_at=now()+interval '30 seconds'
          FROM ready,writing_flow.pair p
         WHERE h.handoff_id=ready.handoff_id AND p.pair_id=h.pair_id
        RETURNING h.handoff_id,h.pair_id,h.to_stage,h.send_count,p.submission_revision`,
      [limit]);
      return claimed.rows.map(row => ({
        handoffId: row.handoff_id,
        pairId: row.pair_id,
        revision: row.submission_revision,
        stageKey: row.to_stage,
        sendCount: row.send_count,
      }));
    });
  }

  // Bước chạy quá hạn không giữ bài vô hạn: thêm một yêu cầu thử lại từ đúng bước.
  // Nếu đã đủ ba lượt, bài vào danh sách Cần kiểm tra của cùng cặp và phiên bản.
  async function recoverExpired(limit = 20) {
    const candidates = await pool.query(`
      SELECT s.pair_id,s.stage_key
        FROM writing_flow.stage_result s
        JOIN writing_flow.pair p ON p.pair_id=s.pair_id
       WHERE s.status='running' AND s.lease_expires_at<=now()
         AND p.status NOT IN ('delivered','superseded')
       ORDER BY s.lease_expires_at,s.pair_id
       LIMIT $1`, [limit]);
    const recovered = [];
    for (const candidate of candidates.rows) {
      const result = await withTransaction(pool, async client => {
        const pairResult = await client.query(`SELECT status FROM writing_flow.pair
          WHERE pair_id=$1 FOR UPDATE`, [candidate.pair_id]);
        if (pairResult.rowCount !== 1
          || ['delivered', 'superseded'].includes(pairResult.rows[0].status)) return null;
        const stageResult = await client.query(`
          SELECT cycle_no,attempt_count,status,lease_expires_at
            FROM writing_flow.stage_result
           WHERE pair_id=$1 AND stage_key=$2 FOR UPDATE`,
        [candidate.pair_id, candidate.stage_key]);
        const stage = stageResult.rows[0];
        if (!stage || stage.status !== 'running'
          || new Date(stage.lease_expires_at).getTime() > Date.now()) return null;
        const attempt = await client.query(`
          UPDATE writing_flow.stage_attempt
             SET status='unknown',error_code='STAGE_TIMEOUT',finished_at=now()
           WHERE pair_id=$1 AND stage_key=$2 AND cycle_no=$3 AND attempt_no=$4
             AND status='sent'
           RETURNING attempt_id`,
        [candidate.pair_id, candidate.stage_key, stage.cycle_no, stage.attempt_count]);
        if (attempt.rowCount !== 1) return null;
        if (stage.attempt_count < 3) {
          await client.query(`UPDATE writing_flow.stage_result
            SET status='pending',error_code='STAGE_TIMEOUT',lease_expires_at=NULL,updated_at=now()
            WHERE pair_id=$1 AND stage_key=$2`, [candidate.pair_id, candidate.stage_key]);
          await client.query(`INSERT INTO writing_flow.handoff
            (pair_id,from_stage,to_stage,source_result_sha256,next_send_at)
            VALUES ($1,'retry',$2,$3,now())
            ON CONFLICT (pair_id,from_stage,to_stage,source_result_sha256) DO NOTHING`,
          [candidate.pair_id, candidate.stage_key, sha256(attempt.rows[0].attempt_id)]);
          return { pairId: candidate.pair_id, stageKey: candidate.stage_key,
            status: 'retry_requested' };
        }
        await client.query(`UPDATE writing_flow.stage_result
          SET status='needs_review',error_code='STAGE_TIMEOUT',lease_expires_at=NULL,updated_at=now()
          WHERE pair_id=$1 AND stage_key=$2`, [candidate.pair_id, candidate.stage_key]);
        await client.query(`UPDATE writing_flow.pair SET status='needs_review',updated_at=now()
          WHERE pair_id=$1`, [candidate.pair_id]);
        await client.query(`INSERT INTO writing_flow.manual_review
          (pair_id,stage_key,cycle_no,error_code)
          VALUES ($1,$2,$3,'STAGE_TIMEOUT')
          ON CONFLICT (pair_id,stage_key,cycle_no) DO NOTHING`,
        [candidate.pair_id, candidate.stage_key, stage.cycle_no]);
        return { pairId: candidate.pair_id, stageKey: candidate.stage_key,
          status: 'needs_review' };
      });
      if (result) recovered.push(result);
    }
    return recovered;
  }

  return { due, recoverExpired };
}
