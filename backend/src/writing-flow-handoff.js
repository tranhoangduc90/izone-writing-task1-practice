import { withTransaction } from './db.js';
import { sha256 } from './writing-flow-crypto.js';

// Nhận vào: số yêu cầu bàn giao tối đa của một lượt quét.
// Việc chính: cấp lại những yêu cầu chưa được bước sau xác nhận, cùng đúng mã cặp/phiên bản.
// Trả ra: danh sách nhỏ để n8n gọi workflow bước sau mà không chờ kết quả chấm.
// Khi n8n đã nhận một bàn giao: giữ nguyên trong hàng đợi đủ lâu để execution chờ suất chạy.
// Chỉ phát lại sau sáu giờ như một lớp cứu hộ cuối, tránh nhân bản execution khi n8n đang đông.
export function createWritingFlowHandoff({ pool }) {
  async function due(limit = 20) {
    return withTransaction(pool, async client => {
      await client.query(`
        UPDATE writing_flow.handoff h SET status='acknowledged', acknowledged_at=now()
        FROM writing_flow.pair p
        WHERE h.pair_id=p.pair_id AND h.status IN ('pending','sent')
          AND (p.status='superseded'
            OR (p.status='delivered' AND h.to_stage<>'trcc_repair'))`);
      await client.query(`
        UPDATE writing_flow.handoff h SET status='acknowledged', acknowledged_at=now()
        FROM writing_flow.stage_result s
        WHERE h.pair_id=s.pair_id AND h.to_stage=s.stage_key
          AND h.status IN ('pending','sent')
          AND (s.status IN ('succeeded','skipped')
            OR (s.status='needs_review' AND h.from_stage<>'review'))`);
      async function claimBatch({ delivery, capacity }) {
        if (capacity <= 0) return [];
        const stageFilter = delivery ? "h.to_stage='deliver'" : "h.to_stage<>'deliver'";
        // Google khóa ghi theo phiên bản tài liệu. Chỉ phát một bài của cùng homework
        // trong một lượt và đợi bàn giao trước được nhận, tránh hai bài cùng sửa một
        // revision rồi một bài thất bại vì revision vừa trở thành cũ.
        const documentGuard = delivery ? `AND NOT EXISTS (
          SELECT 1 FROM writing_flow.handoff sibling
          JOIN writing_flow.pair sibling_pair ON sibling_pair.pair_id=sibling.pair_id
          WHERE sibling.handoff_id<>h.handoff_id
            AND sibling.to_stage='deliver'
            AND sibling_pair.homework_file_id=p.homework_file_id
            AND (
              (sibling.status='sent'
                AND sibling.last_sent_at>now()-interval '15 minutes')
              OR (
                ((sibling.status='pending' AND sibling.next_send_at<=now())
                  OR (sibling.status='sent' AND sibling.next_send_at<=now()
                    AND sibling.last_sent_at<=now()-interval '6 hours'))
                AND (sibling.next_send_at,sibling.created_at,sibling.handoff_id)
                  < (h.next_send_at,h.created_at,h.handoff_id)
              )
            )
        )` : '';
        const claimed = await client.query(`
        WITH ready AS (
          SELECT h.handoff_id
            FROM writing_flow.handoff h
            JOIN writing_flow.pair p ON p.pair_id=h.pair_id
           WHERE ((h.status='pending' AND h.next_send_at<=now())
               OR (h.status='sent' AND h.next_send_at<=now()
                 AND h.last_sent_at<=now()-interval '6 hours'))
             AND p.status<>'superseded'
             AND (p.status<>'delivered' OR h.to_stage='trcc_repair')
             AND NOT (p.source_type='term_test' AND h.to_stage='main')
             AND ${stageFilter}
             ${documentGuard}
           ORDER BY h.next_send_at,h.created_at,h.handoff_id
           LIMIT $1 FOR UPDATE OF h SKIP LOCKED
        )
        UPDATE writing_flow.handoff h
           SET status='sent',send_count=h.send_count+1,last_sent_at=now(),
               next_send_at=now()+interval '6 hours'
          FROM ready,writing_flow.pair p
         WHERE h.handoff_id=ready.handoff_id AND p.pair_id=h.pair_id
        RETURNING h.handoff_id,h.pair_id,h.to_stage,h.send_count,p.submission_revision`,
        [capacity]);
        return claimed.rows;
      }
      // Ghi Google có quota riêng: tối đa 20 lượt mỗi phút. Phần dung lượng còn lại
      // vẫn dành cho các bước AI và tạo trang, nên không khôi phục giới hạn ba bài.
      const deliveryLimit = Math.min(20, Math.max(1, Math.floor(limit / 5)));
      const deliveryRows = await claimBatch({ delivery: true, capacity: deliveryLimit });
      const otherRows = await claimBatch({ delivery: false,
        capacity: Math.max(0, limit - deliveryRows.length) });
      return [...deliveryRows, ...otherRows].map(row => ({
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
        await client.query(`UPDATE writing_flow.ai_call
          SET status='failed',error_code='STAGE_TIMEOUT',finished_at=COALESCE(finished_at,now())
          WHERE attempt_id=$1 AND status='sent'`, [attempt.rows[0].attempt_id]);
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
