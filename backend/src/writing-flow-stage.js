import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { keyFromHex, open, seal, sha256 } from './writing-flow-crypto.js';
import { storeWritingTestDelivery, storeWritingTestMainResult } from './writing-flow-test.js';
import { requireCompletedTestComponents } from './writing-flow-test-components.js';

const STAGES = ['precheck', 'main', 'critic', 'arbiter', 'render', 'deliver'];
export const LEASE_SECONDS = { precheck: 600, main: 600, critic: 600, arbiter: 600, render: 300, deliver: 180 };
export function leaseSecondsForStage(stageKey, sourceType) {
  // Bộ Test cũ gọi 13/14 workflow nối tiếp; một lượt thật đã mất gần sáu phút.
  // Chừa thời gian cho AI chậm để lease không hết và khởi phát chấm trùng.
  if (sourceType === 'term_test' && stageKey === 'main') return 1800;
  // Writer Test cũ có thể chờ Google tới 180 giây; chừa thêm thời gian
  // để đọc lại và lưu biên nhận trước khi hệ thống cứu việc quá hạn.
  if (sourceType === 'term_test' && stageKey === 'deliver') return 600;
  return LEASE_SECONDS[stageKey];
}
const NEXT = { precheck: ['main'], main: ['critic'], critic: ['arbiter', 'render'],
  arbiter: ['render'], render: ['deliver'], deliver: [null] };

// Google có thể yêu cầu giảm nhịp khi nhiều homework được ghi cùng lúc.
// Lỗi quota Google khi ghi tài liệu chờ 90 giây; revision đổi chờ 30 giây.
// Lỗi khác được backend giao lại ngay. Sau khi bỏ node gọi trực tiếp, hẹn sáu giờ
// ở đây sẽ khiến một bài chờ sáu giờ mới có lần chấm thứ hai.
export function stageRetryPolicy(stageKey, errorCode) {
  const googleRateLimited = stageKey === 'deliver' && errorCode === 'GOOGLE_API_RATE_LIMIT';
  const googleRevisionChanged = stageKey === 'deliver'
    && errorCode === 'GOOGLE_DOC_REVISION_CHANGED';
  return {
    retryImmediately: !(googleRateLimited || googleRevisionChanged),
    handoffDelaySeconds: googleRateLimited ? 90 : googleRevisionChanged ? 30 : 0,
  };
}

function decode(value, key) {
  return JSON.parse(open(value, key));
}

// Nhận vào: lời xác nhận đã tạo trang cho một cặp bài.
// Việc chính: chỉ nhận link xem có cùng mã trang, version và bằng chứng đọc lại.
// Trả ra: lỗi rõ ràng trước khi lưu bàn giao ghi vào homework.
export function verifyWritingRenderResult(result, sourceType = 'lark_homework') {
  if (sourceType === 'term_test') {
    const report = String(result?.reportMarkdown || '');
    // Nhận điểm ở mẫu Test cũ và mẫu chuyển tiếp; giữ nguyên báo cáo gốc.
    const scoreInReport = /<h1>Overall:\s*<strong>([0-9](?:[.,]5)?)<\/strong><\/h1>/iu.exec(report)
      || /Điểm Task:\s*(?:\*\*)?([0-9](?:[.,]5)?)/u.exec(report);
    if (result?.readbackOk !== true || typeof result.reportMarkdown !== 'string'
      || result.reportMarkdown.trim().length < 80 || result.reportMarkdown.length > 450000
      || !scoreInReport || Number(scoreInReport[1].replace(',', '.')) !== Number(result.taskScore)
      || !Number.isFinite(Number(result.taskScore)) || result.resultUrl) {
      throw new ApiError(409, 'RENDER_TEST_REPORT_INVALID',
        'Bản nhận xét và điểm Test chưa đủ để ghi vào tài liệu.');
    }
    return;
  }
  const match = /^https:\/\/ducizone\.ddns\.net\/writing\/shared\/writing-essays\/([a-f0-9]{48})\/view\?v=(\d+)$/u
    .exec(String(result?.resultUrl || ''));
  if (result?.readbackOk !== true || !match
    || result.writerGroupId !== match[1]
    || !Number.isInteger(result.version) || result.version < 1
    || Number(match[2]) !== result.version
    || !Number.isInteger(result.correctionsCount) || result.correctionsCount < 1) {
    throw new ApiError(409, 'RENDER_READBACK_MISSING',
      'Chưa xác nhận đúng trang kết quả của bài này.');
  }
}

// Dữ liệu nhận vào: biên nhận writer và bản nhận xét Test hoặc link Homework đã lưu.
// Việc chính: đối chiếu đúng tài liệu, vị trí và nội dung đã đọc lại trước khi báo Đã giao.
// Kết quả: Test chỉ cần nhận xét/điểm trong Docs; Homework giữ kiểm link LMS như cũ.
export function verifyWritingDeliveryResult(result, rendered, pair, sourceType = 'lark_homework') {
  const samePlace = result?.readbackOk === true
    && result.homeworkFileId === pair.homework_file_id
    && Number(result.essaySlot) === Number(pair.essay_slot)
    && Number(result.sourceLinkIndex) === Number(pair.source_link_index);
  if (sourceType === 'term_test') {
    if (!samePlace || result.resultUrl || !rendered?.reportMarkdown
      || result.writerPayloadHash !== sha256(rendered.reportMarkdown)) {
      throw new ApiError(409, 'DELIVERY_TEST_READBACK_MISMATCH',
        'Bản nhận xét trong tài liệu không khớp bài Test đã chấm.');
    }
    return;
  }
  if (!samePlace || typeof result.resultUrl !== 'string'
    || !result.resultUrl.startsWith('https://')
    || result.resultUrl !== rendered?.resultUrl) {
    throw new ApiError(409, 'DELIVERY_RESULT_MISMATCH',
      'Link hoặc vị trí ghi không khớp cặp bài đã chấm.');
  }
}

// Nhận vào: mã cặp, phiên bản và yêu cầu bàn giao đã ghi bền.
// Việc chính: khóa cặp/bước, chống nhận hai lần, cấp lượt thử và nạp thành quả đã mã hóa.
// Trả ra: đúng đầu vào của một giai đoạn hoặc trạng thái đã chạy/chưa được phép.
// Khi lỗi: rollback; không đánh dấu bàn giao đã nhận nếu chưa tạo được lượt thử.
export function createWritingFlowStage({ pool, encryptionKey }) {
  const key = keyFromHex(encryptionKey);
  async function claim({ pairId, revision, stageKey, handoffId, executionId }) {
    if (!key) throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY', 'Chưa cấu hình nơi lưu bài chấm.');
    if (!STAGES.includes(stageKey)) throw new ApiError(400, 'STAGE_INVALID', 'Bước chấm không hợp lệ.');
    return withTransaction(pool, async client => {
      const pairResult = await client.query(`
        SELECT pair_id, submission_revision, status, source_ciphertext,
               source_app_id, source_table_id, source_record_id,
               homework_file_id, source_link_index,
               essay_slot, class_code, document_kind, source_modified_at,
               source_type, source_id, trcc_required_override,
               (SELECT s.display_name FROM writing_flow.source_record AS s
                 WHERE s.source_id=p.source_id) AS source_display_name,
               (SELECT g.test_config FROM writing_flow.test_group AS g
                 WHERE g.source_id=p.source_id) AS test_config
          FROM writing_flow.pair AS p WHERE pair_id = $1 FOR UPDATE`, [pairId]);
      if (pairResult.rowCount !== 1) throw new ApiError(404, 'PAIR_NOT_FOUND', 'Không tìm thấy bài chấm.');
      const pair = pairResult.rows[0];
      if (pair.submission_revision !== revision) {
        throw new ApiError(409, 'PAIR_REVISION_CHANGED', 'Bài đã có phiên bản khác.');
      }
      const handoffResult = await client.query(`
        SELECT handoff_id, from_stage, to_stage, source_result_sha256, status
          FROM writing_flow.handoff
         WHERE handoff_id = $1 AND pair_id = $2 FOR UPDATE`, [handoffId, pairId]);
      if (handoffResult.rowCount !== 1 || handoffResult.rows[0].to_stage !== stageKey) {
        throw new ApiError(409, 'HANDOFF_MISMATCH', 'Yêu cầu bàn giao không khớp bài và bước.');
      }
      const handoff = handoffResult.rows[0];
      // Một lệnh đã đóng có thể vẫn nằm trong hàng đợi n8n. Không cho lệnh cũ
      // nhận lượt thử mới sau khi người vận hành đã retry từ bước trước.
      if (!['pending', 'sent'].includes(handoff.status)) {
        return { status: 'superseded', pairId, stageKey };
      }
      if (pair.status === 'superseded') {
        await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',
          acknowledged_at=now() WHERE handoff_id=$1`, [handoffId]);
        return { status: 'superseded', pairId, stageKey };
      }
      if (pair.status === 'delivered') {
        await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',
          acknowledged_at=now() WHERE handoff_id=$1`, [handoffId]);
        return { status: 'already_delivered', pairId, stageKey };
      }
      if (handoff.from_stage !== 'review' && handoff.from_stage !== 'retry') {
        await client.query(`
          INSERT INTO writing_flow.stage_result
            (pair_id, stage_key, status, input_sha256)
          VALUES ($1,$2,'pending',$3)
          ON CONFLICT (pair_id,stage_key) DO NOTHING`,
        [pairId, stageKey, handoff.source_result_sha256]);
      }
      const stageResult = await client.query(`
        SELECT pair_id, stage_key, status, cycle_no, attempt_count,
               input_sha256, error_code, lease_expires_at
          FROM writing_flow.stage_result
         WHERE pair_id=$1 AND stage_key=$2 FOR UPDATE`, [pairId, stageKey]);
      if (stageResult.rowCount !== 1) {
        throw new ApiError(409, 'STAGE_NOT_READY', 'Bước chấm chưa có nguồn hợp lệ.');
      }
      let stage = stageResult.rows[0];
      if (stage.status === 'succeeded' || stage.status === 'skipped') {
        await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',
          acknowledged_at=now() WHERE handoff_id=$1`, [handoffId]);
        return { status: 'already_finished', pairId, stageKey };
      }
      if (handoff.from_stage === 'review') {
        const reviewResult = await client.query(`
          SELECT review_id, cycle_no, status, retry_command_key
            FROM writing_flow.manual_review
           WHERE pair_id=$1 AND stage_key=$2 AND status='retry_requested'
           FOR UPDATE`, [pairId, stageKey]);
        const review = reviewResult.rows[0];
        if (reviewResult.rowCount !== 1 || stage.status !== 'needs_review'
          || review.cycle_no !== stage.cycle_no
          || sha256(review.retry_command_key) !== handoff.source_result_sha256) {
          throw new ApiError(409, 'REVIEW_RETRY_MISMATCH', 'Yêu cầu chạy lại sau kiểm tra không khớp.');
        }
        await client.query(`
          UPDATE writing_flow.manual_review
             SET status='retry_accepted', retry_accepted_at=now()
           WHERE review_id=$1`, [review.review_id]);
        await client.query(`
          UPDATE writing_flow.stage_result
             SET status='pending', cycle_no=cycle_no+1, attempt_count=0,
                 error_code=NULL, started_at=NULL, lease_expires_at=NULL,
                 updated_at=now()
           WHERE pair_id=$1 AND stage_key=$2`, [pairId, stageKey]);
        stage = { ...stage, status: 'pending', cycle_no: stage.cycle_no + 1,
          attempt_count: 0, error_code: null };
        await client.query(`UPDATE writing_flow.pair SET status='running',updated_at=now()
          WHERE pair_id=$1`, [pairId]);
      }
      // Khi quản trị viên yêu cầu xuất lại một bài đã giao, bước tạo trang sinh
      // mã kết quả mới. Chỉ bước giao link đã được đặt rõ REPUBLISH_REQUESTED,
      // chưa có lượt thử trong chu kỳ mới, mới được nhận mã này.
      const acceptsRepublishedRender = stageKey === 'deliver'
        && handoff.from_stage === 'render'
        && stage.status === 'pending'
        && Number(stage.attempt_count) === 0
        && stage.error_code === 'REPUBLISH_REQUESTED';
      // Retry từ một bước trước đánh dấu các bước sau đang chờ đầu vào mới. Lần
      // bàn giao mới đầu tiên được phép thay hash; từ lượt thứ hai vẫn khóa chặt.
      const acceptsResetInput = handoff.from_stage !== 'retry'
        && stage.status === 'pending'
        && Number(stage.attempt_count) === 0
        && stage.error_code === 'UPSTREAM_RETRY_REQUESTED';
      if ((acceptsRepublishedRender || acceptsResetInput)
        && stage.input_sha256 !== handoff.source_result_sha256) {
        await client.query(`UPDATE writing_flow.stage_result
          SET input_sha256=$3,error_code=NULL,updated_at=now()
          WHERE pair_id=$1 AND stage_key=$2`,
        [pairId, stageKey, handoff.source_result_sha256]);
        stage = { ...stage, input_sha256: handoff.source_result_sha256 };
      } else if (!['retry', 'review'].includes(handoff.from_stage)
        && stage.input_sha256 !== handoff.source_result_sha256) {
        throw new ApiError(409, 'STAGE_INPUT_CHANGED', 'Đầu vào bước chấm không khớp bản đã lưu.');
      }
      if (stage.status === 'needs_review') {
        await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',
          acknowledged_at=now() WHERE handoff_id=$1`, [handoffId]);
        return { status: 'needs_review', pairId, stageKey };
      }
      if (stage.status === 'running' && stage.lease_expires_at
        && new Date(stage.lease_expires_at).getTime() > Date.now()) {
        return { status: 'already_running', pairId, stageKey };
      }
      if (stage.status === 'running') {
        await client.query(`
          UPDATE writing_flow.stage_attempt
             SET status='unknown', error_code='STAGE_TIMEOUT', finished_at=now()
           WHERE pair_id=$1 AND stage_key=$2 AND cycle_no=$3
             AND attempt_no=$4 AND status='sent'`,
        [pairId, stageKey, stage.cycle_no, stage.attempt_count]);
        await client.query(`UPDATE writing_flow.ai_call AS c
          SET status='failed',error_code='STAGE_TIMEOUT',finished_at=COALESCE(finished_at,now())
          FROM writing_flow.stage_attempt AS a
          WHERE c.attempt_id=a.attempt_id AND c.status='sent'
            AND a.pair_id=$1 AND a.stage_key=$2 AND a.cycle_no=$3 AND a.attempt_no=$4`,
        [pairId, stageKey, stage.cycle_no, stage.attempt_count]);
      }
      if (stage.attempt_count >= 3) {
        await client.query(`UPDATE writing_flow.stage_result
          SET status='needs_review',error_code='STAGE_TIMEOUT',lease_expires_at=NULL,
              updated_at=now() WHERE pair_id=$1 AND stage_key=$2`, [pairId, stageKey]);
        await client.query(`UPDATE writing_flow.pair SET status='needs_review',updated_at=now()
          WHERE pair_id=$1`, [pairId]);
        await client.query(`UPDATE writing_flow.manual_review
          SET status='resolved',resolved_at=now()
          WHERE pair_id=$1 AND stage_key=$2 AND status<>'resolved'`, [pairId, stageKey]);
        await client.query(`
          INSERT INTO writing_flow.manual_review
            (pair_id, stage_key, cycle_no, error_code)
          VALUES ($1,$2,$3,'STAGE_TIMEOUT')
          ON CONFLICT (pair_id,stage_key,cycle_no) DO NOTHING`,
        [pairId, stageKey, stage.cycle_no]);
        return { status: 'needs_review', pairId, stageKey };
      }
      if (stageKey === 'deliver') {
        // Google Docs giới hạn lượt ghi theo người dùng/phút. Khóa ngắn này
        // giữ ngân sách chung giữa nhiều API instance và mọi bài Homework/Test.
        // AI ở các bước trước vẫn chạy theo concurrency của n8n.
        await client.query(`SELECT pg_advisory_xact_lock(hashtext('writing_flow_docs_delivery_budget'))`);
        const recent = await client.query(`SELECT count(*) AS recent_count
          FROM writing_flow.stage_attempt
          WHERE stage_key='deliver' AND started_at>now()-interval '60 seconds'`);
        if (Number(recent.rows[0]?.recent_count ?? 0) >= 12) {
          await client.query(`UPDATE writing_flow.handoff
            SET status='pending',next_send_at=now()+interval '65 seconds'
            WHERE handoff_id=$1`, [handoffId]);
          await client.query(`SELECT pg_notify('writing_flow_work_ready','handoff')`);
          return { status: 'deferred', pairId, stageKey, retryAfterSeconds: 65 };
        }
      }
      const attemptNo = Number(stage.attempt_count) + 1;
      const requestKey = crypto.randomUUID();
      const attemptResult = await client.query(`
        INSERT INTO writing_flow.stage_attempt
          (pair_id,stage_key,cycle_no,attempt_no,request_key,status,n8n_execution_id)
        VALUES ($1,$2,$3,$4,$5,'sent',$6)
        RETURNING attempt_id`,
      [pairId, stageKey, stage.cycle_no, attemptNo, requestKey, executionId]);
      await client.query(`
        UPDATE writing_flow.stage_result
           SET status='running', attempt_count=$3, n8n_execution_id=$4,
               started_at=now(), lease_expires_at=now()+($5::integer*interval '1 second'),
               updated_at=now()
         WHERE pair_id=$1 AND stage_key=$2`,
      [pairId, stageKey, attemptNo, executionId,
        leaseSecondsForStage(stageKey, pair.source_type)]);
      await client.query(`UPDATE writing_flow.pair SET status='running',updated_at=now()
        WHERE pair_id=$1`, [pairId]);
      await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',
        acknowledged_at=now() WHERE handoff_id=$1`, [handoffId]);
      const results = await client.query(`
        SELECT stage_key,result_ciphertext
          FROM writing_flow.stage_result
         WHERE pair_id=$1 AND status='succeeded'
         ORDER BY CASE stage_key
           WHEN 'intake' THEN 1 WHEN 'precheck' THEN 2 WHEN 'main' THEN 3
           WHEN 'critic' THEN 4 WHEN 'arbiter' THEN 5 WHEN 'render' THEN 6 ELSE 7 END`, [pairId]);
      const previous = Object.fromEntries(results.rows.map(row =>
        [row.stage_key, decode(row.result_ciphertext, key)]));
      if (stageKey === 'render' && pair.trcc_required_override === true) {
        const repairResult = await client.query(`SELECT status,result_ciphertext
          FROM writing_flow.trcc_repair WHERE pair_id=$1`, [pairId]);
        if (repairResult.rowCount !== 1 || repairResult.rows[0].status !== 'succeeded'
          || !repairResult.rows[0].result_ciphertext) {
          throw new ApiError(409, 'TRCC_REPAIR_RESULT_MISSING',
            'Bài cần cứu TR/CC nhưng chưa có kết quả đã lưu.');
        }
        const repair = decode(repairResult.rows[0].result_ciphertext, key);
        const repairedText = String(repair?.text ?? '').trim();
        if (!repairedText || !previous.precheck) {
          throw new ApiError(409, 'TRCC_REPAIR_RESULT_INVALID', 'Kết quả cứu TR/CC không hợp lệ.');
        }
        previous.precheck = { ...previous.precheck, tr_cc: repairedText,
          trcc_mode: 'repair', trcc_prompt_key: repair.promptKey || 'repair' };
      }
      return {
        status: 'started', pairId, revision, stageKey,
        attemptId: attemptResult.rows[0].attempt_id, attemptNo,
        requestKey, cycleNo: stage.cycle_no,
        source: (() => {
          const [taskType, topic, image, essay, trCcCheck] = decode(pair.source_ciphertext, key);
          return { taskType, topic, image, essay,
            trCcCheck: trCcCheck === true || pair.trcc_required_override === true,
            appId: pair.source_app_id,
            tableId: pair.source_table_id,
            recordId: pair.source_record_id,
            homeworkFileId: pair.homework_file_id,
            sourceLinkIndex: pair.source_link_index,
            essaySlot: pair.essay_slot,
            classCode: pair.class_code,
            documentKind: pair.document_kind,
            sourceType: pair.source_type || 'lark_homework',
            sourceId: pair.source_id || null,
            sourceDisplayName: pair.source_display_name || null,
            ...(pair.test_config ? { testConfig: pair.test_config } : {}),
            sourceModifiedAt: new Date(pair.source_modified_at).toISOString() };
        })(),
        previous,
      };
    });
  }

  // Một kết quả hợp lệ đến trước được chốt; callback đến muộn vẫn lưu nhưng không ghi đè.
  async function complete({ pairId, revision, stageKey, attemptId, result, nextStage }) {
    if (!key) throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY', 'Chưa cấu hình nơi lưu bài chấm.');
    if (!STAGES.includes(stageKey) || !NEXT[stageKey].includes(nextStage)) {
      throw new ApiError(400, 'STAGE_TRANSITION_INVALID', 'Bước bàn giao tiếp theo không hợp lệ.');
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw new ApiError(400, 'STAGE_RESULT_INVALID', 'Kết quả bước chấm không hợp lệ.');
    }
    const resultJson = JSON.stringify(result);
    if (!resultJson || resultJson.length > 500000) {
      throw new ApiError(400, 'STAGE_RESULT_TOO_LARGE', 'Kết quả bước chấm vượt giới hạn.');
    }
    const resultSha = sha256(resultJson);
    const resultCiphertext = seal(resultJson, key);
    return withTransaction(pool, async client => {
      const pairResult = await client.query(`
        SELECT pair_id, submission_revision, status, homework_file_id,
               source_link_index, essay_slot,source_type
          FROM writing_flow.pair WHERE pair_id=$1 FOR UPDATE`, [pairId]);
      if (pairResult.rowCount !== 1) throw new ApiError(404, 'PAIR_NOT_FOUND', 'Không tìm thấy bài chấm.');
      const pair = pairResult.rows[0];
      if (pair.submission_revision !== revision) {
        throw new ApiError(409, 'PAIR_REVISION_CHANGED', 'Bài đã có phiên bản khác.');
      }
      const stageResult = await client.query(`
        SELECT status,cycle_no,selected_attempt_no,input_sha256
          FROM writing_flow.stage_result
         WHERE pair_id=$1 AND stage_key=$2 FOR UPDATE`, [pairId, stageKey]);
      const attemptResult = await client.query(`
        SELECT attempt_id,cycle_no,attempt_no,status
          FROM writing_flow.stage_attempt
         WHERE attempt_id=$1 AND pair_id=$2 AND stage_key=$3 FOR UPDATE`,
      [attemptId, pairId, stageKey]);
      if (stageResult.rowCount !== 1 || attemptResult.rowCount !== 1) {
        throw new ApiError(409, 'STAGE_ATTEMPT_MISMATCH', 'Lượt chấm không khớp cặp bài.');
      }
      const stage = stageResult.rows[0];
      const attempt = attemptResult.rows[0];
      if (stage.status === 'succeeded' && stage.selected_attempt_no === attempt.attempt_no
        && stage.cycle_no === attempt.cycle_no) {
        return { status: 'already_finished', pairId, stageKey };
      }
      if (pair.status === 'superseded' || stage.cycle_no !== attempt.cycle_no
        || stage.status === 'succeeded' || pair.status === 'delivered') {
        await client.query(`UPDATE writing_flow.stage_attempt
          SET status='late',result_sha256=$2,result_ciphertext=$3,finished_at=now()
          WHERE attempt_id=$1`, [attemptId, resultSha, resultCiphertext]);
        return { status: 'late', pairId, stageKey };
      }
      if (stageKey === 'render') {
        verifyWritingRenderResult(result, pair.source_type);
        if (pair.source_type === 'term_test') {
          const score = await client.query(`SELECT task_score FROM writing_flow.test_pair
            WHERE pair_id=$1`, [pairId]);
          if (score.rowCount !== 1 || Number(score.rows[0].task_score) !== Number(result.taskScore)) {
            throw new ApiError(409, 'RENDER_TEST_SCORE_MISMATCH',
              'Điểm trên bản nhận xét không khớp điểm Test đã lưu.');
          }
        }
      }
      if (stageKey === 'deliver') {
        const rendered = await client.query(`SELECT result_ciphertext
          FROM writing_flow.stage_result
          WHERE pair_id=$1 AND stage_key='render' AND status='succeeded'`, [pairId]);
        const savedResult = rendered.rowCount === 1
          ? decode(rendered.rows[0].result_ciphertext, key) : null;
        verifyWritingDeliveryResult(result, savedResult, pair, pair.source_type);
      }
      if (pair.source_type === 'term_test' && stageKey === 'main') {
        // Khi bộ chấm từng thành phần đã bắt đầu, không cho bản tổng hợp đi tắt
        // nếu thiếu một khía cạnh hoặc một trong bốn tiêu chí.
        await requireCompletedTestComponents(client, {
          pairId, inputSha256: stage.input_sha256 });
        const linked = await client.query(`SELECT task_number FROM writing_flow.test_pair
          WHERE pair_id=$1 FOR UPDATE`, [pairId]);
        if (linked.rowCount !== 1) {
          throw new ApiError(409, 'TEST_PAIR_LINK_MISSING', 'Bài Test chưa được ghép đúng Task.');
        }
        await storeWritingTestMainResult(client, { pairId,
          taskNumber: Number(linked.rows[0].task_number), result, encryptionKey: key });
      }
      if (pair.source_type === 'term_test' && stageKey === 'deliver') {
        await storeWritingTestDelivery(client, { pairId, result });
      }
      await client.query(`UPDATE writing_flow.stage_attempt
        SET status='succeeded',result_sha256=$2,result_ciphertext=$3,finished_at=now()
        WHERE attempt_id=$1`, [attemptId, resultSha, resultCiphertext]);
      await client.query(`UPDATE writing_flow.stage_result
        SET status='succeeded',result_sha256=$3,result_ciphertext=$4,
            selected_attempt_no=$5,completed_at=now(),lease_expires_at=NULL,
            error_code=NULL,updated_at=now()
        WHERE pair_id=$1 AND stage_key=$2`,
      [pairId, stageKey, resultSha, resultCiphertext, attempt.attempt_no]);
      await client.query(`UPDATE writing_flow.manual_review
        SET status='resolved',resolved_at=now()
        WHERE pair_id=$1 AND stage_key=$2 AND status<>'resolved'`, [pairId, stageKey]);
      await client.query(`UPDATE writing_flow.handoff
        SET status='acknowledged',acknowledged_at=now()
        WHERE pair_id=$1 AND from_stage='review' AND to_stage=$2
          AND status IN ('pending','sent')`, [pairId, stageKey]);
      if (stageKey === 'critic' && nextStage === 'render') {
        await client.query(`INSERT INTO writing_flow.stage_result
          (pair_id,stage_key,status,input_sha256)
          VALUES ($1,'arbiter','skipped',$2)
          ON CONFLICT (pair_id,stage_key) DO NOTHING`, [pairId, resultSha]);
      }
      await client.query(`UPDATE writing_flow.pair
        SET status=$2,finished_at=CASE WHEN $2='delivered' THEN now() ELSE NULL END,
            updated_at=now() WHERE pair_id=$1`,
      [pairId, stageKey === 'deliver' ? 'delivered' : 'running']);
      let handoffId = null;
      if (nextStage) {
        // Kết quả đã lưu bền; giao việc đến hạn ngay để backend đánh thức bước sau.
        // Nếu tín hiệu bị mất, bản ghi pending vẫn được bộ phục hồi tìm lại.
        const handoff = await client.query(`
          INSERT INTO writing_flow.handoff
            (pair_id,from_stage,to_stage,source_result_sha256,next_send_at)
          VALUES ($1,$2,$3,$4,now())
          RETURNING handoff_id`, [pairId, stageKey, nextStage, resultSha]);
        handoffId = handoff.rows[0].handoff_id;
      }
      return { status: stageKey === 'deliver' ? 'delivered' : 'succeeded',
        pairId, stageKey, handoffId, nextStage, resultSha256: resultSha };
    });
  }

  // Một bước lỗi được gửi lại ngay; đúng lượt thứ ba mới mở mục Cần kiểm tra.
  async function fail({ pairId, revision, stageKey, attemptId, errorCode, unknown = false }) {
    if (!STAGES.includes(stageKey)) throw new ApiError(400, 'STAGE_INVALID', 'Bước chấm không hợp lệ.');
    return withTransaction(pool, async client => {
      const pairResult = await client.query(`SELECT submission_revision,status
        FROM writing_flow.pair WHERE pair_id=$1 FOR UPDATE`, [pairId]);
      if (pairResult.rowCount !== 1) throw new ApiError(404, 'PAIR_NOT_FOUND', 'Không tìm thấy bài chấm.');
      const pair = pairResult.rows[0];
      if (pair.submission_revision !== revision) {
        throw new ApiError(409, 'PAIR_REVISION_CHANGED', 'Bài đã có phiên bản khác.');
      }
      const stageResult = await client.query(`SELECT status,cycle_no,attempt_count
        FROM writing_flow.stage_result
        WHERE pair_id=$1 AND stage_key=$2 FOR UPDATE`, [pairId, stageKey]);
      const attemptResult = await client.query(`SELECT cycle_no,attempt_no,status
        FROM writing_flow.stage_attempt
        WHERE attempt_id=$1 AND pair_id=$2 AND stage_key=$3 FOR UPDATE`,
      [attemptId, pairId, stageKey]);
      if (stageResult.rowCount !== 1 || attemptResult.rowCount !== 1) {
        throw new ApiError(409, 'STAGE_ATTEMPT_MISMATCH', 'Lượt chấm không khớp cặp bài.');
      }
      const stage = stageResult.rows[0];
      const attempt = attemptResult.rows[0];
      if (attempt.status !== 'sent') return { status: 'already_recorded', pairId, stageKey };
      const stale = pair.status === 'superseded' || pair.status === 'delivered'
        || stage.status === 'succeeded' || stage.cycle_no !== attempt.cycle_no;
      await client.query(`UPDATE writing_flow.stage_attempt
        SET status=$2,error_code=$3,finished_at=now() WHERE attempt_id=$1`,
      [attemptId, stale ? 'late' : unknown ? 'unknown' : 'failed', errorCode]);
      await client.query(`UPDATE writing_flow.ai_call
        SET status='failed',error_code=$2,finished_at=COALESCE(finished_at,now())
        WHERE attempt_id=$1 AND status='sent'`, [attemptId, errorCode]);
      if (stale) return { status: 'late', pairId, stageKey };
      if (stage.attempt_count < 3) {
        const retryPolicy = stageRetryPolicy(stageKey, errorCode);
        await client.query(`UPDATE writing_flow.stage_result
          SET status='pending',error_code=$3,lease_expires_at=NULL,updated_at=now()
          WHERE pair_id=$1 AND stage_key=$2`, [pairId, stageKey, errorCode]);
        const handoff = await client.query(`INSERT INTO writing_flow.handoff
          (pair_id,from_stage,to_stage,source_result_sha256,next_send_at)
          VALUES ($1,'retry',$2,$3,now()+($4::text||' seconds')::interval) RETURNING handoff_id`,
        [pairId, stageKey, sha256(attemptId), retryPolicy.handoffDelaySeconds]);
        return { status: 'retry_requested', pairId, stageKey,
          handoffId: handoff.rows[0].handoff_id,
          retryImmediately: retryPolicy.retryImmediately };
      }
      await client.query(`UPDATE writing_flow.stage_result
        SET status='needs_review',error_code=$3,lease_expires_at=NULL,updated_at=now()
        WHERE pair_id=$1 AND stage_key=$2`, [pairId, stageKey, errorCode]);
      await client.query(`UPDATE writing_flow.pair SET status='needs_review',updated_at=now()
        WHERE pair_id=$1`, [pairId]);
      await client.query(`UPDATE writing_flow.manual_review
        SET status='resolved',resolved_at=now()
        WHERE pair_id=$1 AND stage_key=$2 AND status<>'resolved'`, [pairId, stageKey]);
      await client.query(`INSERT INTO writing_flow.manual_review
        (pair_id,stage_key,cycle_no,error_code)
        VALUES ($1,$2,$3,$4)
        ON CONFLICT (pair_id,stage_key,cycle_no)
        DO UPDATE SET error_code=EXCLUDED.error_code`,
      [pairId, stageKey, stage.cycle_no, errorCode]);
      return { status: 'needs_review', pairId, stageKey };
    });
  }

  return { claim, complete, fail };
}
