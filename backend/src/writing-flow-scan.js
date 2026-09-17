import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { ApiError } from './service.js';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const itemKey = item => digest([item.recordId, item.docId ?? '', item.linkIndex]);

// Nhận vào: danh sách toàn bộ link tìm được khi đã đọc hết các trang của một bảng Lark.
// Việc chính: ghi danh sách trước khi chấm; một lượt dở giữ nguyên mốc và được quét lại.
// Trả ra: mã lượt quét cùng khóa từng link, không trả nội dung bài học viên.
// Khi lỗi: giao dịch hoàn tác và mốc quét không đổi.
export function createWritingFlowScan({ pool }) {
  return {
    async begin({ requestKey, appId, tableId, scannedThroughAt, pageCount, reachedEnd, items }) {
      if (!reachedEnd) throw new ApiError(409, 'SCAN_NOT_COMPLETE', 'Chưa đọc hết các trang hồ sơ.');
      const cutoff = new Date(scannedThroughAt);
      if (!Number.isFinite(cutoff.getTime()) || cutoff.getTime() > Date.now() + 60_000) {
        throw new ApiError(400, 'SCAN_CUTOFF_INVALID', 'Thời điểm quét không hợp lệ.');
      }
      const manifest = items.map(item => ({
        ...item, itemKey: itemKey(item),
      }));
      if (new Set(manifest.map(item => item.itemKey)).size !== manifest.length
        || new Set(manifest.map(item => [item.recordId, item.linkIndex].join(':'))).size !== manifest.length) {
        throw new ApiError(409, 'SCAN_DUPLICATE_LINK', 'Một link xuất hiện hai lần trong lượt quét.');
      }
      const manifestSha256 = digest([appId, tableId, cutoff.toISOString(),
        pageCount, reachedEnd, manifest]);
      return withTransaction(pool, async client => {
        await client.query(`INSERT INTO writing_flow.scan_cursor
          (source_app_id,source_table_id) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [appId, tableId]);
        const cursor = await client.query(`SELECT scanned_through_at
          FROM writing_flow.scan_cursor WHERE source_app_id=$1 AND source_table_id=$2
          FOR UPDATE`, [appId, tableId]);
        const replay = await client.query(`SELECT run_id,manifest_sha256,status
          FROM writing_flow.scan_run WHERE request_key=$1`, [requestKey]);
        if (replay.rowCount) {
          const row = replay.rows[0];
          if (row.manifest_sha256 !== manifestSha256) {
            throw new ApiError(409, 'SCAN_REQUEST_CONFLICT', 'Mã lượt quét cũ có danh sách khác.');
          }
          return { runId: row.run_id, status: row.status,
            previousCursor: cursor.rows[0].scanned_through_at,
            items: manifest.map(({ itemKey: key, recordId, linkIndex }) => ({ itemKey: key, recordId, linkIndex })) };
        }
        const active = await client.query(`SELECT run_id,started_at
          FROM writing_flow.scan_run WHERE source_app_id=$1 AND source_table_id=$2
            AND status='open' FOR UPDATE`, [appId, tableId]);
        if (active.rowCount) {
          if (Date.now() - new Date(active.rows[0].started_at).getTime() < 30 * 60_000) {
            throw new ApiError(409, 'SCAN_ALREADY_RUNNING', 'Bảng này đang có lượt quét chưa hoàn tất.');
          }
          await client.query(`UPDATE writing_flow.scan_run SET status='abandoned'
            WHERE run_id=$1`, [active.rows[0].run_id]);
        }
        const created = await client.query(`INSERT INTO writing_flow.scan_run
          (request_key,manifest_sha256,source_app_id,source_table_id,
           scanned_through_at,page_count,reached_end,expected_count)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING run_id`,
        [requestKey, manifestSha256, appId, tableId, cutoff.toISOString(),
          pageCount, reachedEnd, manifest.length]);
        const runId = created.rows[0].run_id;
        for (const item of manifest) {
          await client.query(`INSERT INTO writing_flow.scan_item
            (run_id,item_key,source_record_id,homework_file_id,source_link_index,class_code)
            VALUES ($1,$2,$3,$4,$5,$6)`,
          [runId, item.itemKey, item.recordId, item.docId, item.linkIndex, item.classCode ?? null]);
        }
        return { runId, status: 'open', previousCursor: cursor.rows[0].scanned_through_at,
          items: manifest.map(({ itemKey: key, recordId, linkIndex }) => ({ itemKey: key, recordId, linkIndex })) };
      });
    },

    // Nhận vào: biên nhận cặp bài, khóa lỗi nguồn hoặc kết luận tài liệu trống.
    // Việc chính: kiểm các mã thật trong database trước khi công nhận một link đã xử lý.
    // Trả ra: trạng thái bền của link; gửi trùng cùng trạng thái là an toàn.
    // Khi lỗi: link vẫn pending để lượt quét không thể chốt nhầm.
    async acknowledge({ runId, itemKey: key, status, pairIds = [],
      issueKeys = [], detectedSlotCount = null }) {
      return withTransaction(pool, async client => {
        const receiptSha256 = digest([status, [...pairIds].sort(),
          [...issueKeys].sort(), detectedSlotCount]);
        const found = await client.query(`SELECT i.*,r.status AS run_status,
          r.source_app_id,r.source_table_id
          FROM writing_flow.scan_item i JOIN writing_flow.scan_run r ON r.run_id=i.run_id
          WHERE i.run_id=$1 AND i.item_key=$2 FOR UPDATE OF i`, [runId, key]);
        if (!found.rowCount) throw new ApiError(404, 'SCAN_ITEM_NOT_FOUND', 'Không thấy link trong lượt quét.');
        const item = found.rows[0];
        if (item.run_status !== 'open') {
          throw new ApiError(409, 'SCAN_RUN_CLOSED', 'Lượt quét đã đóng.');
        }
        if (item.status !== 'pending') {
          if (item.status === status && item.receipt_sha256 === receiptSha256) {
            return { itemKey: key, status };
          }
          throw new ApiError(409, 'SCAN_ITEM_CONFLICT', 'Link đã có kết luận khác.');
        }
        const needsPairs = status === 'accepted' || status === 'partial';
        const needsIssues = status === 'issue' || status === 'partial';
        if (needsPairs && (!pairIds.length || new Set(pairIds).size !== pairIds.length)) {
          throw new ApiError(400, 'SCAN_PAIR_RECEIPT_INVALID', 'Thiếu hoặc trùng biên nhận bài.');
        }
        if (needsIssues && (!issueKeys.length || new Set(issueKeys).size !== issueKeys.length)) {
          throw new ApiError(400, 'SCAN_ISSUE_RECEIPT_INVALID', 'Thiếu hoặc trùng biên nhận lỗi.');
        }
        if (!needsPairs && pairIds.length || !needsIssues && issueKeys.length) {
          throw new ApiError(400, 'SCAN_RECEIPT_STATUS_MISMATCH', 'Biên nhận không khớp trạng thái.');
        }
        let pairs = { rows: [], rowCount: 0 };
        if (needsPairs) {
          pairs = await client.query(`SELECT pair_id,source_app_id,source_table_id,
            source_record_id,homework_file_id,source_link_index,essay_slot
            FROM writing_flow.pair WHERE pair_id=ANY($1::uuid[])`, [pairIds]);
          if (pairs.rowCount !== pairIds.length || pairs.rows.some(pair =>
            pair.source_app_id !== item.source_app_id
            || pair.source_table_id !== item.source_table_id
            || pair.source_record_id !== item.source_record_id
            || pair.homework_file_id !== item.homework_file_id
            || pair.source_link_index !== item.source_link_index)) {
            throw new ApiError(409, 'SCAN_PAIR_RECEIPT_MISMATCH', 'Biên nhận không thuộc link này.');
          }
          // Kiểm cả số ô gốc: hai phiên bản của cùng một ô không được tính là hai bài.
          if (new Set(pairs.rows.map(pair => pair.essay_slot)).size !== pairs.rowCount) {
            throw new ApiError(409, 'SCAN_DUPLICATE_ESSAY_SLOT', 'Biên nhận lặp ô bài.');
          }
        }
        let issues = { rows: [], rowCount: 0 };
        if (needsIssues) {
          issues = await client.query(`SELECT issue_key,essay_slot FROM writing_flow.source_issue
            WHERE issue_key=ANY($1::text[]) AND source_app_id=$2 AND source_table_id=$3
              AND source_record_id=$4 AND homework_file_id IS NOT DISTINCT FROM $5
              AND source_link_index=$6 AND status='open'`,
          [issueKeys, item.source_app_id, item.source_table_id, item.source_record_id,
            item.homework_file_id, item.source_link_index]);
          if (issues.rowCount !== issueKeys.length) {
            throw new ApiError(409, 'SCAN_ISSUE_RECEIPT_MISMATCH', 'Chưa có đủ lỗi nguồn đúng link.');
          }
        }
        if (status === 'accepted' || status === 'partial'
          || status === 'issue' && detectedSlotCount !== null) {
          const slots = [...pairs.rows.map(pair => pair.essay_slot),
            ...issues.rows.map(issue => issue.essay_slot)];
          if (slots.some(slot => !Number.isInteger(slot))
            || new Set(slots).size !== slots.length
            || detectedSlotCount !== slots.length) {
            throw new ApiError(409, 'SCAN_SLOT_COUNT_MISMATCH', 'Chưa đủ biên nhận cho các ô có bài.');
          }
        }
        if (status === 'issue' && detectedSlotCount === null
          && (issues.rowCount !== 1 || issues.rows[0].essay_slot !== null)) {
          throw new ApiError(409, 'SCAN_FILE_ISSUE_REQUIRED', 'Thiếu lỗi của cả tài liệu.');
        }
        if (status === 'excluded') {
          if (item.class_code?.toUpperCase() !== 'IC2288') {
            throw new ApiError(409, 'SCAN_EXCLUSION_MISMATCH', 'Chỉ lớp IC2288 được bỏ qua.');
          }
        } else if (status === 'empty') {
          if (detectedSlotCount !== 0) {
            throw new ApiError(409, 'SCAN_NOT_EMPTY', 'Tài liệu còn ô có bài.');
          }
        } else if (!['accepted','partial','issue'].includes(status)) {
          throw new ApiError(400, 'SCAN_STATUS_INVALID', 'Trạng thái link không hợp lệ.');
        }
        await client.query(`UPDATE writing_flow.scan_item
          SET status=$3,expected_pair_count=$4,receipt_pair_count=$5,
              receipt_issue_count=$6,source_issue_keys=$7,receipt_sha256=$8,
              acknowledged_at=now()
          WHERE run_id=$1 AND item_key=$2`,
        [runId, key, status, detectedSlotCount, pairIds.length,
          issueKeys.length, issueKeys, receiptSha256]);
        return { itemKey: key, status };
      });
    },

    // Nhận vào: mã lượt quét sau khi từng link đã có biên nhận.
    // Việc chính: kiểm số link pending rồi mới cập nhật mốc trong cùng transaction.
    // Trả ra: số link đã đối chiếu và mốc quét mới; khi còn thiếu báo lỗi rõ ràng.
    async finish({ runId }) {
      return withTransaction(pool, async client => {
        const run = await client.query(`SELECT * FROM writing_flow.scan_run
          WHERE run_id=$1 FOR UPDATE`, [runId]);
        if (!run.rowCount) throw new ApiError(404, 'SCAN_RUN_NOT_FOUND', 'Không thấy lượt quét.');
        const row = run.rows[0];
        if (row.status === 'abandoned') throw new ApiError(409, 'SCAN_RUN_ABANDONED', 'Lượt quét đã quá hạn.');
        const counts = await client.query(`SELECT count(*)::integer AS total,
          count(*) FILTER (WHERE status='pending')::integer AS pending
          FROM writing_flow.scan_item WHERE run_id=$1`, [runId]);
        const { total, pending } = counts.rows[0];
        if (total !== row.expected_count || pending !== 0) {
          throw new ApiError(409, 'SCAN_UNACKNOWLEDGED_ITEMS', 'Còn link chưa có biên nhận hoặc lỗi.');
        }
        if (row.status === 'open') {
          await client.query(`UPDATE writing_flow.scan_cursor
            SET scanned_through_at=GREATEST(scanned_through_at,$3),
                last_run_id=$4,updated_at=now()
            WHERE source_app_id=$1 AND source_table_id=$2`,
          [row.source_app_id, row.source_table_id, row.scanned_through_at, runId]);
          await client.query(`UPDATE writing_flow.scan_run
            SET status='complete',completed_at=now() WHERE run_id=$1`, [runId]);
        }
        const cursor = await client.query(`SELECT scanned_through_at
          FROM writing_flow.scan_cursor WHERE source_app_id=$1 AND source_table_id=$2`,
        [row.source_app_id, row.source_table_id]);
        return { runId, status: 'complete', total, scannedThroughAt: cursor.rows[0].scanned_through_at };
      });
    },

    async cursor({ appId, tableId }) {
      const result = await pool.query(`SELECT scanned_through_at
        FROM writing_flow.scan_cursor WHERE source_app_id=$1 AND source_table_id=$2`,
      [appId, tableId]);
      return { appId, tableId, scannedThroughAt: result.rows[0]?.scanned_through_at ?? null };
    },
  };
}
