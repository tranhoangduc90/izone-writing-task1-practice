import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { ApiError } from './service.js';

const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const itemKey = item => digest([item.recordId, item.docId ?? '', item.linkIndex]);

// Nhận vào: phiên bản từng ô đã lưu và kết quả workflow vừa đọc lại từng file.
// Việc chính: từ chối chốt nếu thiếu file, sai ô hoặc nội dung bài đã đổi.
// Trả ra: số file và bài được xác minh; không đọc hoặc trả nội dung học viên.
// Khi lỗi: ném mã lỗi để hồ sơ tiếp tục ở trạng thái chờ.
export function verifyClosureContent(closure, observations, nowMs = Date.now()) {
  if (closure?.eligible !== true || !Array.isArray(closure.links)
    || !Array.isArray(observations)
    || closure.links.length !== observations.length) {
    throw new ApiError(409, 'CLOSURE_CONTENT_PROOF_MISSING',
      'Chưa đọc lại đủ file homework.');
  }
  const currentByLink = new Map();
  for (const observed of observations) {
    if (!Number.isSafeInteger(observed.linkIndex) || observed.linkIndex <= 0
      || currentByLink.has(observed.linkIndex)
      || !Number.isSafeInteger(observed.observedAtMs)
      || observed.observedAtMs < nowMs - 5 * 60_000
      || observed.observedAtMs > nowMs + 60_000) {
      throw new ApiError(409, 'CLOSURE_CONTENT_PROOF_STALE',
        'Bản đọc file thiếu định danh hoặc đã quá hạn.');
    }
    currentByLink.set(observed.linkIndex, observed);
  }
  let pairCount = 0;
  for (const expected of closure.links) {
    const current = currentByLink.get(expected.linkIndex);
    if (!current || current.docId !== expected.docId
      || !Array.isArray(expected.expectedPairs)
      || !['accepted', 'empty'].includes(current.status)) {
      throw new ApiError(409, 'CLOSURE_CONTENT_PROOF_MISMATCH',
        'File homework hoặc trạng thái đọc không khớp.');
    }
    if (current.status === 'empty'
      && current.receiptRequest?.expectedPairs?.length) {
      throw new ApiError(409, 'CLOSURE_CONTENT_PROOF_MISMATCH',
        'File được báo trống nhưng vẫn có bài.');
    }
    const actualPairs = current.status === 'empty' ? []
      : current.receiptRequest?.expectedPairs;
    if (!Array.isArray(actualPairs)
      || current.status === 'accepted' && actualPairs.length === 0) {
      throw new ApiError(409, 'CLOSURE_CONTENT_PROOF_MISMATCH',
        'Chưa có danh sách bài vừa đọc.');
    }
    const wanted = [...expected.expectedPairs].sort((a, b) => a.essaySlot - b.essaySlot);
    const actual = [...actualPairs].sort((a, b) => a.essaySlot - b.essaySlot);
    if (wanted.length !== actual.length
      || wanted.some((pair, index) => pair.essaySlot !== actual[index]?.essaySlot
        || pair.revision !== actual[index]?.revision)) {
      throw new ApiError(409, 'CLOSURE_ESSAY_CHANGED',
        'Đề hoặc bài làm đã đổi sau lần tiếp nhận.');
    }
    pairCount += wanted.length;
  }
  if (pairCount !== closure.expectedPairCount) {
    throw new ApiError(409, 'CLOSURE_CONTENT_PROOF_MISMATCH',
      'Số bài vừa đọc không khớp biên nhận.');
  }
  return { verifiedLinkCount: closure.links.length, verifiedPairCount: pairCount };
}

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
        expectedPairs: [],
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
      for (const [index, item] of items.rows.entries()) {
        if (item.status === 'empty') continue;
        const pairIds = item.receipt_pair_ids;
        if (!Array.isArray(pairIds)
          || pairIds.length !== item.expected_pair_count
          || new Set(pairIds).size !== pairIds.length) {
          return { eligible: false, reason: 'SCAN_RECEIPT_MISMATCH',
            runId: run.run_id, links };
        }
        const pairs = await pool.query(`SELECT p.pair_id,p.status,
            p.source_app_id,p.source_table_id,p.source_record_id,
            p.homework_file_id,p.source_link_index,p.essay_slot,
            p.submission_revision,
            s.status AS delivery_status
          FROM writing_flow.pair p
          LEFT JOIN writing_flow.stage_result s
            ON s.pair_id=p.pair_id AND s.stage_key='deliver'
          WHERE p.pair_id=ANY($1::uuid[])`, [pairIds]);
        expected += Number(item.expected_pair_count);
        const wrongSource = pairs.rows.some(pair =>
          pair.source_app_id !== appId || pair.source_table_id !== tableId
          || pair.source_record_id !== recordId
          || pair.homework_file_id !== item.homework_file_id
          || pair.source_link_index !== item.source_link_index);
        const slots = pairs.rows.map(pair => pair.essay_slot);
        if (pairs.rowCount !== item.expected_pair_count || wrongSource
          || new Set(slots).size !== slots.length) {
          return { eligible: false, reason: 'SCAN_RECEIPT_MISMATCH',
            runId: run.run_id, links };
        }
        if (pairs.rows.some(pair => pair.status !== 'delivered'
          || pair.delivery_status !== 'succeeded')) {
          return { eligible: false, reason: 'PAIR_NOT_DELIVERED',
            runId: run.run_id, links };
        }
        links[index].expectedPairs = pairs.rows.map(pair => ({
          essaySlot: pair.essay_slot, revision: pair.submission_revision,
        })).sort((left, right) => left.essaySlot - right.essaySlot);
      }
      if (!expected) return { eligible: false, reason: 'NO_WRITING_PAIR',
        runId: run.run_id, links };
      // Nhận vào: hồ sơ này đã từng được chốt ở lượt quét trước hay chưa.
      // Việc chính: so đúng file, vị trí, ô và phiên bản với lần hoàn tất trước.
      // Trả ra: cờ cần ghi mốc mới khi học viên đã sửa bài hoặc đổi link.
      // Khi thiếu lịch sử cũ: chọn ghi mốc mới, không dùng một ngày cũ chưa xác minh.
      const previous = await pool.query(`SELECT c.run_id
        FROM writing_flow.record_closure c
        JOIN writing_flow.scan_run r ON r.run_id=c.run_id
        WHERE r.source_app_id=$1 AND r.source_table_id=$2
          AND c.source_record_id=$3 AND c.closed_at IS NOT NULL
          AND c.run_id<>$4
        ORDER BY c.closed_at DESC,c.run_id DESC LIMIT 1`,
      [appId, tableId, recordId, run.run_id]);
      let needsNewTimestamp = true;
      if (previous.rowCount) {
        const priorRows = await pool.query(`SELECT i.source_link_index,
            i.homework_file_id,p.essay_slot,p.submission_revision
          FROM writing_flow.scan_item i
          LEFT JOIN LATERAL unnest(i.receipt_pair_ids) AS selected(pair_id) ON TRUE
          LEFT JOIN writing_flow.pair p ON p.pair_id=selected.pair_id
          WHERE i.run_id=$1 AND i.source_record_id=$2
          ORDER BY i.source_link_index,p.essay_slot`,
        [previous.rows[0].run_id, recordId]);
        const priorLinks = [];
        for (const row of priorRows.rows) {
          let prior = priorLinks.find(link => link.linkIndex === row.source_link_index);
          if (!prior) {
            prior = { linkIndex: row.source_link_index,
              docId: row.homework_file_id, expectedPairs: [] };
            priorLinks.push(prior);
          }
          if (row.essay_slot !== null) prior.expectedPairs.push({
            essaySlot: row.essay_slot, revision: row.submission_revision });
        }
        needsNewTimestamp = JSON.stringify(priorLinks) !== JSON.stringify(links);
      }
      return { eligible: true, reason: 'ALL_PAIRS_DELIVERED',
        runId: run.run_id, scannedThroughAt: run.scanned_through_at,
        expectedPairCount: expected, links, needsNewTimestamp };
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
        // Lượt mới của cùng hồ sơ làm biên nhận chốt cũ hết hiệu lực.
        await client.query(`UPDATE writing_flow.record_closure c
          SET status='superseded'
          FROM writing_flow.scan_run r
          WHERE c.run_id=r.run_id AND r.source_app_id=$1
            AND r.source_table_id=$2 AND c.run_id<>$3
            AND c.source_record_id=ANY($4::text[])
            AND c.status IN ('pending','done')`,
        [appId, tableId, runId, [...new Set(manifest.map(item => item.recordId))]]);
        return { runId, status: 'open', appId, tableId, requestKey,
          previousCursor: cursor.rows[0].scanned_through_at,
          items: manifest.map(({ itemKey: key, recordId, linkIndex }) => ({ itemKey: key, recordId, linkIndex })) };
      });
    },

    // Nhận vào: danh sách ô dự kiến của một link trước khi gửi từng ô đi độc lập.
    // Việc chính: khóa kế hoạch trong database để workflow đọc nguồn không phải chờ từng ô.
    // Trả ra: mã kế hoạch bền; gửi lại cùng kế hoạch là an toàn.
    // Khi thiếu biên nhận: link còn pending và mốc quét không được chốt.
    async prepare({ runId, itemKey: key, status, detectedSlotCount, receiptRequest }) {
      const pairCount = receiptRequest.expectedPairs.length;
      const issueCount = receiptRequest.expectedIssues.length;
      if (status === 'accepted' && (!pairCount || issueCount)
        || status === 'partial' && (!pairCount || !issueCount)
        || status === 'issue' && (pairCount || !issueCount)
        || detectedSlotCount !== null && detectedSlotCount !== pairCount + issueCount) {
        throw new ApiError(400, 'SCAN_PLAN_COUNT_INVALID', 'Kế hoạch ô không khớp trạng thái link.');
      }
      const plan = { status, detectedSlotCount, receiptRequest };
      const planSha256 = digest(plan);
      return withTransaction(pool, async client => {
        const found = await client.query(`SELECT i.status,i.receipt_plan_sha256,
            i.source_record_id,i.homework_file_id,i.source_link_index,
            r.status AS run_status,r.source_app_id,r.source_table_id
          FROM writing_flow.scan_item i JOIN writing_flow.scan_run r ON r.run_id=i.run_id
          WHERE i.run_id=$1 AND i.item_key=$2 FOR UPDATE OF i`, [runId, key]);
        if (!found.rowCount) throw new ApiError(404, 'SCAN_ITEM_NOT_FOUND', 'Không thấy link trong lượt quét.');
        const item = found.rows[0];
        if (item.run_status !== 'open' || item.status !== 'pending') {
          throw new ApiError(409, 'SCAN_ITEM_NOT_PENDING', 'Link không còn chờ tiếp nhận.');
        }
        if (receiptRequest.appId !== item.source_app_id
          || receiptRequest.tableId !== item.source_table_id
          || receiptRequest.recordId !== item.source_record_id
          || receiptRequest.docId !== item.homework_file_id
          || receiptRequest.linkIndex !== item.source_link_index) {
          throw new ApiError(409, 'SCAN_PLAN_SCOPE_MISMATCH', 'Kế hoạch ô không thuộc link này.');
        }
        // Bài có thể được sửa khi link còn pending: chỉ kế hoạch mới nhất được chốt.
        if (item.receipt_plan_sha256 !== planSha256) {
          await client.query(`UPDATE writing_flow.scan_item
            SET receipt_plan=$3,receipt_plan_sha256=$4,planned_at=now()
            WHERE run_id=$1 AND item_key=$2`, [runId, key, plan, planSha256]);
        }
        return { itemKey: key, status: 'planned', operationCount: pairCount + issueCount,
          planSha256 };
      });
    },

    // Nhận vào: biên nhận cặp bài, khóa lỗi nguồn hoặc kết luận tài liệu trống.
    // Việc chính: kiểm các mã thật trong database trước khi công nhận một link đã xử lý.
    // Trả ra: trạng thái bền của link; gửi trùng cùng trạng thái là an toàn.
    // Khi lỗi: link vẫn pending để lượt quét không thể chốt nhầm.
    async acknowledge({ runId, itemKey: key, status, pairIds = [],
      issueKeys = [], detectedSlotCount = null, expectedPlanSha256 = null }) {
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
        if (expectedPlanSha256 && item.receipt_plan_sha256 !== expectedPlanSha256) {
          throw new ApiError(409, 'SCAN_PLAN_REPLACED',
            'Bài đã đổi trong lúc đối chiếu; sẽ dùng kế hoạch mới.');
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
        // Nguồn Classroom và file thêm thủ công dùng cùng sổ quét bền. Khi link đã
        // có biên nhận thật, đánh dấu nguồn đã xử lý để bộ phát không gửi lại vô hạn.
        await client.query(`UPDATE writing_flow.source_record
          SET dispatch_status=CASE WHEN $6='issue' THEN 'needs_review'
                WHEN $6='excluded' THEN 'excluded' ELSE 'acknowledged' END,
              acknowledged_at=CASE WHEN $6 IN ('accepted','partial','empty') THEN now()
                ELSE acknowledged_at END,next_dispatch_at=NULL,
              last_error_code=CASE WHEN $6='issue' THEN coalesce(last_error_code,'SOURCE_ISSUE')
                ELSE NULL END,updated_at=now()
          WHERE source_app_id=$1 AND source_table_id=$2 AND source_record_id=$3
            AND homework_file_id IS NOT DISTINCT FROM $4 AND source_link_index=$5
            AND source_type IN ('google_classroom','manual')`,
        [item.source_app_id, item.source_table_id, item.source_record_id,
          item.homework_file_id, item.source_link_index, status]);
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
        // Chỉ hồ sơ không còn lỗi nguồn mới cần kiểm chốt; hồ sơ lỗi chờ lượt quét mới.
        await client.query(`INSERT INTO writing_flow.record_closure
          (run_id,source_record_id)
          SELECT run_id,source_record_id
          FROM writing_flow.scan_item WHERE run_id=$1
          GROUP BY run_id,source_record_id
          HAVING bool_and(status IN ('accepted','empty'))
            AND bool_or(status='accepted')
          ON CONFLICT DO NOTHING`, [runId]);
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

    // Nhận vào: một lỗi nguồn đã được người vận hành kiểm tra và mã yêu cầu chống bấm trùng.
    // Việc chính: tạo lượt đọc lại chỉ cho đúng link lỗi, dùng nguyên mốc quét hiện tại.
    // Trả ra: lượt quét mới để workflow đọc nguồn tự xử lý; không sửa hồ sơ Lark.
    // Khi lỗi: từ chối mục đã hết hiệu lực, thiếu link hoặc đang có lượt quét cùng bảng.
    async retrySourceIssue({ issueKey, requestId }) {
      const found = await pool.query(`SELECT source_app_id,source_table_id,source_record_id,
          homework_file_id,source_link_index,class_code
        FROM writing_flow.source_issue
        WHERE issue_key=$1 AND status='open'`, [issueKey]);
      if (!found.rowCount) {
        throw new ApiError(404, 'SOURCE_ISSUE_NOT_OPEN',
          'Lỗi nguồn không còn mở hoặc không tồn tại.');
      }
      const issue = found.rows[0];
      if (!Number.isSafeInteger(issue.source_link_index) || issue.source_link_index < 1) {
        throw new ApiError(409, 'SOURCE_ISSUE_RETRY_UNAVAILABLE',
          'Lỗi nguồn chưa có vị trí link để đọc lại tự động.');
      }
      const cursor = await this.cursor({
        appId: issue.source_app_id,
        tableId: issue.source_table_id,
      });
      if (!cursor.scannedThroughAt) {
        throw new ApiError(409, 'SCAN_CURSOR_MISSING',
          'Bảng nguồn chưa có mốc quét để đọc lại an toàn.');
      }
      return this.begin({
        requestKey: `source-issue-retry:${requestId}`,
        appId: issue.source_app_id,
        tableId: issue.source_table_id,
        scannedThroughAt: new Date(cursor.scannedThroughAt).toISOString(),
        pageCount: 1,
        reachedEnd: true,
        items: [{
          recordId: issue.source_record_id,
          docId: issue.homework_file_id,
          linkIndex: issue.source_link_index,
          classCode: issue.class_code,
        }],
      });
    },

    // Nhận vào: số link tối đa để gửi trong một nhịp.
    // Việc chính: cấp lại link chưa có biên nhận, mỗi lần cách nhau ít nhất 30 giây.
    // Trả ra: định danh nguồn để workflow đọc lại bản hiện tại; không chứa bài học viên.
    // Khi workflow sau không chạy: link vẫn pending và được cấp lại.
    async due({ limit = 100 } = {}) {
      return withTransaction(pool, async client => {
        const result = await client.query(`WITH ready AS (
          SELECT i.run_id,i.item_key,s.source_id,s.source_type,
            s.source_updated_at,s.file_url,s.display_name,s.student_name,
            s.teacher_names,s.classroom_url,s.source_status,s.source_created_at,s.metadata
          FROM writing_flow.scan_item i
          JOIN writing_flow.scan_run r ON r.run_id=i.run_id
          LEFT JOIN writing_flow.source_record s
            ON s.source_app_id=r.source_app_id AND s.source_table_id=r.source_table_id
            AND s.source_record_id=i.source_record_id
            AND s.homework_file_id IS NOT DISTINCT FROM i.homework_file_id
            AND s.source_link_index=i.source_link_index
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
          r.source_app_id,r.source_table_id,ready.source_id,ready.source_type,
          ready.source_updated_at,ready.file_url,ready.display_name,ready.student_name,
          ready.teacher_names,ready.classroom_url,ready.source_status,
          ready.source_created_at,ready.metadata`, [limit]);
        return result.rows.map(row => ({
          runId: row.run_id, itemKey: row.item_key,
          appId: row.source_app_id, tableId: row.source_table_id,
          recordId: row.source_record_id, docId: row.homework_file_id,
          linkIndex: row.source_link_index, classCode: row.class_code,
          sendCount: row.send_count,
          ...(row.source_type ? {
            sourceId: row.source_id, sourceType: row.source_type,
            sourceUpdatedAt: row.source_updated_at, fileUrl: row.file_url,
            sourceMeta: { displayName: row.display_name || null,
              studentName: row.student_name || null,
              teacherNames: row.teacher_names || [],
              classroomUrl: row.classroom_url || null,
              fileUrl: row.file_url || null, sourceStatus: row.source_status || null,
              sourceCreatedAt: row.source_created_at || null,
              ...(row.metadata && typeof row.metadata === 'object' ? row.metadata : {}) },
          } : {}),
        }));
      });
    },

    // Nhận vào: các lượt đã đủ biên nhận nhưng chưa kịp chốt mốc.
    // Việc chính: chốt từng bảng bằng cùng phép kiểm của finish.
    // Trả ra: mã lượt đã chốt; lỗi một bảng không đổi mốc bảng khác.
    async finishReady({ limit = 100 } = {}) {
      // Mỗi ô đã được gửi không chờ. Chỉ biên nhận đọc lại từ database mới chốt link.
      // Một link lỗi không được giữ các link và lượt quét khác trong cùng nhịp.
      const failures = [];
      const planned = await pool.query(`SELECT i.run_id,i.item_key,
          i.receipt_plan,i.receipt_plan_sha256
        FROM writing_flow.scan_item i JOIN writing_flow.scan_run r ON r.run_id=i.run_id
        WHERE i.status='pending' AND i.receipt_plan IS NOT NULL AND r.status='open'
        ORDER BY i.next_send_at,i.run_id,i.item_key LIMIT $1`, [limit]);
      for (const item of planned.rows) {
        const plan = item.receipt_plan;
        let receipts;
        try {
          receipts = await this.receipts(plan.receiptRequest);
        } catch (error) {
          if (['SCAN_PAIR_RECEIPT_MISSING','SCAN_ISSUE_RECEIPT_MISSING'].includes(error.code)) {
            continue;
          }
          failures.push({ runId: item.run_id, itemKey: item.item_key,
            step: 'receipt', code: error.code || 'UNEXPECTED_ERROR' });
          continue;
        }
        try {
          await this.acknowledge({ runId: item.run_id, itemKey: item.item_key,
            status: plan.status, detectedSlotCount: plan.detectedSlotCount,
            expectedPlanSha256: item.receipt_plan_sha256,
            pairIds: receipts.pairIds, issueKeys: receipts.issueKeys });
        } catch (error) {
          if (error.code === 'SCAN_PLAN_REPLACED') continue;
          failures.push({ runId: item.run_id, itemKey: item.item_key,
            step: 'acknowledge', code: error.code || 'UNEXPECTED_ERROR' });
        }
      }
      const runs = await pool.query(`SELECT r.run_id FROM writing_flow.scan_run r
        WHERE r.status='open' AND NOT EXISTS (
          SELECT 1 FROM writing_flow.scan_item i
          WHERE i.run_id=r.run_id AND i.status='pending')
        ORDER BY r.started_at,r.run_id LIMIT $1`, [limit]);
      const completed = [];
      for (const row of runs.rows) {
        try {
          completed.push(await this.finish({ runId: row.run_id }));
        } catch (error) {
          failures.push({ runId: row.run_id, step: 'finish',
            code: error.code || 'UNEXPECTED_ERROR' });
        }
      }
      return { scans: completed, failureCount: failures.length,
        failures: failures.slice(0, 10) };
    },

    // Nhận vào: số hồ sơ tối đa cần kiểm tra trong nhịp này.
    // Việc chính: cấp lại hồ sơ chưa chốt mỗi 30 giây; chỉ một lượt cấp thắng khóa.
    // Trả ra: định danh hồ sơ, không chứa bài hay link riêng tư.
    async dueClosures({ limit = 100 } = {}) {
      const result = await pool.query(`WITH ready AS (
        SELECT c.run_id,c.source_record_id
        FROM writing_flow.record_closure c
        JOIN writing_flow.scan_run r ON r.run_id=c.run_id
        WHERE c.status='pending' AND r.status='complete'
          AND c.next_check_at<=now()
        ORDER BY c.next_check_at,c.run_id,c.source_record_id
        LIMIT $1 FOR UPDATE OF c SKIP LOCKED
      )
      UPDATE writing_flow.record_closure c
      SET check_count=c.check_count+1,last_checked_at=now(),
          next_check_at=now()+interval '30 seconds'
      FROM ready,writing_flow.scan_run r
      WHERE c.run_id=ready.run_id
        AND c.source_record_id=ready.source_record_id
        AND r.run_id=c.run_id
      RETURNING c.run_id,c.source_record_id,c.check_count,
        r.source_app_id,r.source_table_id`, [limit]);
      return result.rows.map(row => ({ runId: row.run_id,
        recordId: row.source_record_id, appId: row.source_app_id,
        tableId: row.source_table_id, checkCount: row.check_count }));
    },

    // Nhận vào: thời điểm Lark vừa đọc lại và đúng mã lượt quét.
    // Việc chính: chốt sổ chỉ khi các cặp của lượt ấy vẫn được giao đầy đủ.
    // Khi có bản sửa mới: giữ mục chờ để kiểm lại, không công nhận timestamp cũ.
    async completeClosure({ runId, appId, tableId, recordId, finishedAtMs,
      observations }) {
      if (!Number.isSafeInteger(finishedAtMs) || finishedAtMs <= 0
        || finishedAtMs > Date.now() + 60_000) {
        throw new ApiError(400, 'CLOSURE_TIMESTAMP_INVALID',
          'Thời điểm đọc lại từ Lark không hợp lệ.');
      }
      const eligible = await this.closureEligibility({ appId, tableId, recordId });
      if (!eligible.eligible || eligible.runId !== runId) {
        throw new ApiError(409, 'CLOSURE_ELIGIBILITY_CHANGED',
          'Hồ sơ đã thay đổi hoặc còn bài chưa giao link.');
      }
      verifyClosureContent(eligible, observations);
      return withTransaction(pool, async client => {
        const found = await client.query(`SELECT status,lark_finished_at_ms
          FROM writing_flow.record_closure
          WHERE run_id=$1 AND source_record_id=$2 FOR UPDATE`,
        [runId, recordId]);
        if (!found.rowCount || found.rows[0].status === 'superseded') {
          throw new ApiError(409, 'CLOSURE_RUN_SUPERSEDED',
            'Lượt quét của hồ sơ đã được thay thế.');
        }
        if (found.rows[0].status === 'done') {
          if (Number(found.rows[0].lark_finished_at_ms) !== finishedAtMs) {
            throw new ApiError(409, 'CLOSURE_TIMESTAMP_CONFLICT',
              'Thời điểm Lark không khớp biên nhận đã chốt.');
          }
          return { status: 'done', runId, recordId };
        }
        await client.query(`UPDATE writing_flow.record_closure
          SET status='done',closed_at=now(),lark_finished_at_ms=$3
          WHERE run_id=$1 AND source_record_id=$2`,
        [runId, recordId, finishedAtMs]);
        return { status: 'done', runId, recordId };
      });
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
