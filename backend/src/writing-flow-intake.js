import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { keyFromHex, seal, sha256 } from './writing-flow-crypto.js';

const MIME = {
  google_docs: 'application/vnd.google-apps.document',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Nhận vào: từng tài liệu đã được ToolTG đọc, MIME và giờ sửa xác minh qua Drive.
// Việc chính: ghi tất cả cặp bài của tài liệu trong một transaction, mã hóa nội dung
// và tạo bàn giao bền cho từng cặp mới. Bản đọc cũ không được thay bản mới.
// Trả ra: mã cặp/trạng thái để đối chiếu số phát hiện với số đã ghi.
// Khi lỗi: rollback toàn tài liệu; ToolTG không được dời mốc quét.
export function createWritingFlowIntake({ pool, encryptionKey }) {
  const key = keyFromHex(encryptionKey);
  return async function intakePairs(input) {
    if (input.larkMeta.classCode !== input.classCode) {
      throw new ApiError(400, 'LARK_CLASS_MISMATCH', 'Mã lớp không khớp hồ sơ homework.');
    }
    if (input.classCode.toUpperCase() === 'IC2288') {
      return { status: 'excluded', reason: 'CLASS_EXCLUDED', detectedCount: 0,
        registeredCount: 0, receipts: [] };
    }
    if (!key || key.length !== 32) {
      throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY', 'Chưa cấu hình nơi lưu bài chấm.');
    }
    if (input.documentKind !== 'google_docs' && input.documentKind !== 'docx') {
      throw new ApiError(400, 'FILE_TYPE_UNSUPPORTED', 'Loại file chưa được hỗ trợ.');
    }
    if (input.verifiedMime !== MIME[input.documentKind]) {
      throw new ApiError(400, 'FILE_MIME_MISMATCH', 'Loại file không khớp kết quả kiểm tra.');
    }
    const modifiedMs = Date.parse(input.sourceModifiedAt);
    if (!Number.isFinite(modifiedMs)) {
      throw new ApiError(400, 'SOURCE_MODIFIED_TIME_INVALID', 'Thiếu thời điểm sửa file đã xác minh.');
    }
    const sourceModifiedAt = new Date(modifiedMs).toISOString();
    if (input.expectedCount !== input.pairs.length || input.pairs.length === 0) {
      throw new ApiError(400, 'INTAKE_COUNT_MISMATCH', 'Số bài gửi vào không khớp số bài phát hiện.');
    }
    const slots = new Set(input.pairs.map(pair => pair.essaySlot));
    if (slots.size !== input.pairs.length) {
      throw new ApiError(400, 'INTAKE_DUPLICATE_SLOT', 'Một ô bài xuất hiện hai lần.');
    }
    const prepared = input.pairs.map(pair => {
      const topic = pair.topic.trim();
      const image = pair.image.trim();
      const essay = pair.essay.trim();
      const chartLink = input.larkMeta.imageUrls[pair.essaySlot] ?? '';
      const expectedType = chartLink ? 'task_1' : 'task_2';
      if (pair.taskType !== expectedType || image !== chartLink) {
        throw new ApiError(400, 'LARK_TASK_TYPE_MISMATCH', 'Loại đề hoặc ảnh không khớp ô homework.');
      }
      if (chartLink && !/^https?:\/\/\S+$/i.test(chartLink)) {
        throw new ApiError(400, 'LARK_CHART_LINK_INVALID', 'Link ảnh biểu đồ không hợp lệ.');
      }
      if (!topic || !essay) throw new ApiError(400, 'INTAKE_PAIR_INCOMPLETE', 'Đề hoặc bài làm trống.');
      const sourceJson = JSON.stringify([pair.taskType, topic, image, essay]);
      const revision = sha256(sourceJson);
      if ((pair.revision && revision !== pair.revision)
        || (pair.contentSha256 && revision !== pair.contentSha256)) {
        throw new ApiError(409, 'INTAKE_REVISION_MISMATCH', 'Phiên bản bài không khớp nội dung.');
      }
      const resultJson = JSON.stringify({
        operationKey: input.operationKey,
        recordId: input.recordId,
        docId: input.docId,
        linkIndex: input.linkIndex,
        essaySlot: pair.essaySlot,
        revision,
      });
      return { ...pair, topic, image, essay, revision,
        sourceCiphertext: seal(sourceJson, key),
        resultCiphertext: seal(resultJson, key),
        resultSha256: sha256(resultJson),
      };
    }).sort((a, b) => a.essaySlot - b.essaySlot);

    return withTransaction(pool, async client => {
      const receipts = [];
      for (const pair of prepared) {
        const scope = [input.recordId, input.docId, input.linkIndex, pair.essaySlot];
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [JSON.stringify(scope)]);
        const current = await client.query(`
          SELECT pair_id, submission_revision, source_modified_at, status
            FROM writing_flow.pair
           WHERE source_record_id = $1 AND homework_file_id = $2
             AND source_link_index = $3 AND essay_slot = $4
           ORDER BY source_modified_at DESC, created_at DESC
           LIMIT 1`, scope);
        const newest = current.rows[0];
        if (newest && new Date(newest.source_modified_at).getTime() > modifiedMs) {
          receipts.push({ essaySlot: pair.essaySlot, pairId: newest.pair_id, status: 'stale_read' });
          continue;
        }
        if (newest && new Date(newest.source_modified_at).getTime() === modifiedMs
          && newest.submission_revision !== pair.revision) {
          throw new ApiError(409, 'SOURCE_VERSION_CONFLICT', 'Hai nội dung khác nhau có cùng phiên bản file.');
        }
        if (newest?.submission_revision === pair.revision) {
          if (new Date(newest.source_modified_at).getTime() < modifiedMs) {
            await client.query(`
              UPDATE writing_flow.pair
                 SET source_modified_at = $2, updated_at = now()
               WHERE pair_id = $1`, [newest.pair_id, sourceModifiedAt]);
          }
          receipts.push({ essaySlot: pair.essaySlot, pairId: newest.pair_id,
            status: newest.status === 'superseded' ? 'stale_read' : 'existing' });
          continue;
        }
        await client.query(`
          UPDATE writing_flow.pair SET status = 'superseded', updated_at = now()
           WHERE source_record_id = $1 AND homework_file_id = $2
             AND source_link_index = $3 AND essay_slot = $4
             AND status <> 'superseded'`, scope);
        const inserted = await client.query(`
          INSERT INTO writing_flow.pair
            (source_record_id, homework_file_id, source_link_index, essay_slot,
             submission_revision, source_modified_at, content_sha256, class_code,
             task_type, document_kind, source_ciphertext, encryption_version)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1)
          RETURNING pair_id`, [
          ...scope, pair.revision, sourceModifiedAt, pair.revision, input.classCode,
          pair.taskType, input.documentKind, pair.sourceCiphertext,
        ]);
        const pairId = inserted.rows[0].pair_id;
        await client.query(`
          INSERT INTO writing_flow.stage_result
            (pair_id, stage_key, status, cycle_no, attempt_count, input_sha256,
             result_sha256, result_ciphertext, selected_attempt_no, completed_at)
          VALUES ($1,'intake','succeeded',1,1,$2,$3,$4,1,now())`,
        [pairId, pair.revision, pair.resultSha256, pair.resultCiphertext]);
        await client.query(`
          INSERT INTO writing_flow.stage_attempt
            (pair_id, stage_key, cycle_no, attempt_no, request_key,
             status, result_sha256, result_ciphertext, finished_at)
          VALUES ($1,'intake',1,1,$2,'succeeded',$3,$4,now())`,
        [pairId, `intake:${pairId}`, pair.resultSha256, pair.resultCiphertext]);
        await client.query(`
          INSERT INTO writing_flow.handoff
            (pair_id, from_stage, to_stage, source_result_sha256, next_send_at)
          VALUES ($1,'intake','precheck',$2,now())`,
        [pairId, pair.resultSha256]);
        receipts.push({ essaySlot: pair.essaySlot, pairId, status: 'received' });
      }
      if (receipts.length !== input.expectedCount) {
        throw new ApiError(500, 'INTAKE_READBACK_COUNT_MISMATCH', 'Chưa ghi đủ trạng thái các bài.');
      }
      return { detectedCount: input.expectedCount, registeredCount: receipts.length, receipts };
    });
  };
}
