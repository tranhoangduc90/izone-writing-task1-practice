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
    // Nhận vào: định danh một hồ sơ homework đã được quét.
    // Việc chính: đối chiếu lượt quét mới nhất, lỗi nguồn và kết quả giao từng ô.
    // Trả ra: điều kiện chốt cùng danh sách link để workflow đối chiếu Lark trước khi ghi.
    // Khi chưa đủ dữ liệu: giữ hồ sơ mở và nêu mã lý do, không tự ghi Lark.
    async closureEligibility({ appId, tableId, recordId }) {
      const latest = await pool.query(`SELECT r.run_id,r.status,r.scanned_through_at
        FROM writing_flow.scan_run r
        JOIN writing_flow.scan_item i ON i.run_id=r.run_id
        WHERE r.source_app_id=$1 AND r.source_table_id=$2
          AND i.source_record_id=$3
        ORDER BY r.started_at DESC,r.run_id DESC LIMIT 1`,
      [appId, tableId, recordId]);
      if (!latest.rowCount) return { eligible: false, reason: 'SCAN_NOT_FOUND' };
      const run = latest.rows[0];
      if (run.status !== 'complete') {
        return { eligible: false, reason: 'SCAN_NOT_COMPLETE', runId: run.run_id };
      }
      const items = await pool.query(`SELECT source_link_index,homework_file_id,
          status,expected_pair_count,receipt_pair_ids
        FROM writing_flow.scan_item
        WHERE run_id=$1 AND source_record_id=$2
        ORDER BY source_link_index`, [run.run_id, recordId]);
      const links = items.rows.map(item => ({
        linkIndex: item.source_link_index, docId: item.homework_file_id,
      }));
      if (items.rows.some(item => !['accepted', 'empty'].includes(item.status))) {
        return { eligible: false, reason: 'SCAN_ITEM_UNRESOLVED',
          runId: run.run_id, links };
      }
      const issues = await pool.query(`SELECT count(*)::integer AS issue_count
        FROM writing_flow.source_issue
        WHERE source_app_id=$1 AND source_table_id=$2
          AND source_record_id=$3 AND status='open'`,
      [appId, tableId, recordId]);
      if (Number(issues.rows[0]?.issue_count) > 0) {
        return { eligible: false, reason: 'SOURCE_ISSUE_OPEN',
          runId: run.run_id, links };
      }
      let expected = 0;
      for (const item of items.rows) {
        if (item.status === 'empty') continue;
        const pairIds = item.receipt_pair_ids;
        if (!Array.isArray(pairIds)
          || pairIds.length !== item.expected_pair_count
          || new Set(pairIds).size !== pairIds.length) {
          return { eligible: false, reason: 'SCAN_RECEIPT_MISMATCH',
            runId: run.run_id, links };
        }
        const pairs = await pool.query(`SELECT p.pair_id,p.status,
            s.status AS delivery_status
          FROM writing_flow.pair p
          LEFT JOIN writing_flow.stage_result s
            ON s.pair_id=p.pair_id AND s.stage_key='deliver'
          WHERE p.pair_id=ANY($1::uuid[])`, [pairIds]);
        expected += Number(item.expected_pair_count);
        if (pairs.rowCount !== item.expected_pair_count
          || pairs.rows.some(pair => pair.status !== 'delivered'
            || pair.delivery_status !== 'succeeded')) {
          return { eligible: false, reason: 'PAIR_NOT_DELIVERED',
            runId: run.run_id, links };
        }
      }
      if (!expected) return { eligible: false, reason: 'NO_WRITING_PAIR',
        runId: run.run_id, links };
      return { eligible: true, reason: 'ALL_PAIRS_DELIVERED',
        runId: run.run_id, scannedThroughAt: run.scanned_through_at,
        expectedPairCount: expected, links };
    },
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
          return { runId: row.run_id, status: row.status, appId, tableId, requestKey,
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
        return { runId, status: 'open', appId, tableId, requestKey,
          previousCursor: cursor.rows[0].scanned_through_at,
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
              receipt_pair_ids=$9,acknowledged_at=now()
          WHERE run_id=$1 AND item_key=$2`,
        [runId, key, status, detectedSlotCount, pairIds.length,
          issueKeys.length, issueKeys, receiptSha256, pairIds]);
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

    // Nhận vào: số link tối đa để gửi trong một nhịp.
    // Việc chính: cấp lại link chưa có biên nhận, mỗi lần cách nhau ít nhất 30 giây.
    // Trả ra: định danh nguồn để workflow đọc lại bản hiện tại; không chứa bài học viên.
    // Khi workflow sau không chạy: link vẫn pending và được cấp lại.
    async due({ limit = 100 } = {}) {
      return withTransaction(pool, async client => {
        const result = await client.query(`WITH ready AS (
          SELECT i.run_id,i.item_key FROM writing_flow.scan_item i
          JOIN writing_flow.scan_run r ON r.run_id=i.run_id
          WHERE i.status='pending' AND r.status='open' AND i.next_send_at<=now()
          ORDER BY i.next_send_at,i.run_id,i.item_key
          LIMIT $1 FOR UPDATE OF i SKIP LOCKED
        )
        UPDATE writing_flow.scan_item i
        SET send_count=i.send_count+1,last_sent_at=now(),
            next_send_at=now()+interval '30 seconds'
        FROM ready,writing_flow.scan_run r
        WHERE i.run_id=ready.run_id AND i.item_key=ready.item_key
          AND r.run_id=i.run_id
        RETURNING i.run_id,i.item_key,i.source_record_id,i.homework_file_id,
          i.source_link_index,i.class_code,i.send_count,
          r.source_app_id,r.source_table_id`, [limit]);
        return result.rows.map(row => ({
          runId: row.run_id, itemKey: row.item_key,
          appId: row.source_app_id, tableId: row.source_table_id,
          recordId: row.source_record_id, docId: row.homework_file_id,
          linkIndex: row.source_link_index, classCode: row.class_code,
          sendCount: row.send_count,
        }));
      });
    },

    // Nhận vào: các lượt đã đủ biên nhận nhưng chưa kịp chốt mốc.
    // Việc chính: chốt từng bảng bằng cùng phép kiểm của finish.
    // Trả ra: mã lượt đã chốt; lỗi một bảng không đổi mốc bảng khác.
    async finishReady({ limit = 100 } = {}) {
      const runs = await pool.query(`SELECT r.run_id FROM writing_flow.scan_run r
        WHERE r.status='open' AND NOT EXISTS (
          SELECT 1 FROM writing_flow.scan_item i
          WHERE i.run_id=r.run_id AND i.status='pending')
        ORDER BY r.started_at,r.run_id LIMIT $1`, [limit]);
      const completed = [];
      for (const row of runs.rows) completed.push(await this.finish({ runId: row.run_id }));
      return completed;
    },

    // Nhận vào: các ô bài hoặc lỗi mà bộ đọc tài liệu vừa gửi sang bước tiếp nhận.
    // Việc chính: đọc lại đúng biên nhận từ database, thay vì tin HTTP 200 của workflow con.
    // Trả ra: mã cặp và mã lỗi để xác nhận cả tài liệu trong sổ quét.
    // Khi thiếu một ô: trả lỗi, giữ link pending cho lần thử lại.
    async receipts({ appId, tableId, recordId, docId, linkIndex,
      expectedPairs = [], expectedIssues = [] }) {
      const pairIds = [];
      const issueKeys = [];
      const scope = [appId, tableId, recordId, docId, linkIndex];
      for (const expected of expectedPairs) {
        const match = await pool.query(`SELECT pair_id FROM writing_flow.pair
          WHERE source_app_id=$1 AND source_table_id=$2 AND source_record_id=$3
            AND homework_file_id=$4 AND source_link_index=$5
            AND essay_slot=$6 AND submission_revision=$7 AND status<>'superseded'
          ORDER BY created_at DESC LIMIT 1`,
        [...scope, expected.essaySlot, expected.revision]);
        if (match.rowCount !== 1) {
          throw new ApiError(409, 'SCAN_PAIR_RECEIPT_MISSING', 'Thiếu biên nhận bài của một ô.');
        }
        pairIds.push(match.rows[0].pair_id);
      }
      for (const expected of expectedIssues) {
        const match = await pool.query(`SELECT issue_key FROM writing_flow.source_issue
          WHERE source_app_id=$1 AND source_table_id=$2 AND source_record_id=$3
            AND homework_file_id IS NOT DISTINCT FROM $4
            AND source_link_index=$5 AND essay_slot IS NOT DISTINCT FROM $6
            AND reason_code=$7 AND status='open'
          ORDER BY last_seen_at DESC LIMIT 1`,
        [...scope, expected.essaySlot, expected.reasonCode]);
        if (match.rowCount !== 1) {
          throw new ApiError(409, 'SCAN_ISSUE_RECEIPT_MISSING', 'Thiếu biên nhận lỗi của một ô.');
        }
        issueKeys.push(match.rows[0].issue_key);
      }
      return { pairIds, issueKeys };
    },
  };
}
