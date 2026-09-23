import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { keyFromHex, seal, sha256 } from './writing-flow-crypto.js';
import { writingSearchTokens } from './writing-flow-search.js';

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
    const sourceType = input.sourceType || 'lark_homework';
    const sourceMeta = input.sourceMeta || { teacherNames: [] };
    const isLark = sourceType === 'lark_homework';
    if (isLark && input.larkMeta?.classCode !== input.classCode) {
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
    // Lark cấp giờ sửa của hồ sơ; Drive chỉ cấp giờ sửa file. Cần cả hai
    // để lượt đọc cờ TR/CC cũ không thay lượt mới khi file không đổi.
    const larkModifiedMs = isLark ? input.larkModifiedMs : null;
    if (isLark && (!Number.isSafeInteger(larkModifiedMs) || larkModifiedMs <= 0)) {
      throw new ApiError(400, 'LARK_MODIFIED_TIME_INVALID',
        'Thiếu thời điểm sửa hồ sơ Lark đã xác minh.');
    }
    if (input.expectedCount !== input.pairs.length || input.pairs.length === 0) {
      throw new ApiError(400, 'INTAKE_COUNT_MISMATCH', 'Số bài gửi vào không khớp số bài phát hiện.');
    }
    const slots = new Set(input.pairs.map(pair => pair.essaySlot));
    if (slots.size !== input.pairs.length) {
      throw new ApiError(400, 'INTAKE_DUPLICATE_SLOT', 'Một ô bài xuất hiện hai lần.');
    }
    const prepared = input.pairs.map(pair => {
      if (typeof pair.trCcCheck !== 'boolean') {
        throw new ApiError(400, 'INTAKE_TRCC_FLAG_MISSING', 'Thiếu cờ kiểm TR/CC của bài.');
      }
      const topic = pair.topic.trim();
      const image = pair.image.trim();
      const essay = pair.essay.trim();
      const chartLink = isLark ? (input.larkMeta.imageUrls[pair.essaySlot] ?? '') : image;
      const expectedType = isLark ? (chartLink ? 'task_1' : 'task_2') : pair.taskType;
      if (pair.taskType !== expectedType || (isLark && image !== chartLink)) {
        throw new ApiError(400, 'LARK_TASK_TYPE_MISMATCH', 'Loại đề hoặc ảnh không khớp ô homework.');
      }
      if (chartLink && !/^https?:\/\/\S+$/i.test(chartLink)) {
        throw new ApiError(400, 'LARK_CHART_LINK_INVALID', 'Link ảnh biểu đồ không hợp lệ.');
      }
      if (!topic || !essay) throw new ApiError(400, 'INTAKE_PAIR_INCOMPLETE', 'Đề hoặc bài làm trống.');
      // Dấu nội dung tách khỏi cờ kiểm: đổi cờ Lark tạo phiên bản xử lý mới
      // dù file bài làm không đổi thời điểm sửa.
      const contentSha256 = sha256(JSON.stringify([pair.taskType, topic, image, essay]));
      const sourceJson = JSON.stringify([pair.taskType, topic, image, essay, pair.trCcCheck]);
      const revision = sha256(sourceJson);
      if ((pair.revision && revision !== pair.revision)
        || (pair.contentSha256 && contentSha256 !== pair.contentSha256)) {
        throw new ApiError(409, 'INTAKE_REVISION_MISMATCH', 'Phiên bản bài không khớp nội dung.');
      }
      const resultJson = JSON.stringify({
        operationKey: input.operationKey,
        appId: input.appId,
        tableId: input.tableId,
        recordId: input.recordId,
        docId: input.docId,
        linkIndex: input.linkIndex,
        essaySlot: pair.essaySlot,
        revision,
      });
      return { ...pair, topic, image, essay, revision, contentSha256,
        alreadyGraded: sourceType === 'term_test' && pair.alreadyGraded === true,
        sourceCiphertext: seal(sourceJson, key),
        resultCiphertext: seal(resultJson, key),
        resultSha256: sha256(resultJson),
      };
    }).sort((a, b) => a.essaySlot - b.essaySlot);

    return withTransaction(pool, async client => {
      let sourceId = input.sourceId || null;
      if (sourceId) {
        const source = await client.query(`SELECT source_id,source_app_id,source_table_id,
            source_record_id,homework_file_id,source_link_index
          FROM writing_flow.source_record WHERE source_id=$1 FOR UPDATE`, [sourceId]);
        const row = source.rows[0];
        if (!row || row.source_app_id !== input.appId || row.source_table_id !== input.tableId
          || row.source_record_id !== input.recordId || row.homework_file_id !== input.docId
          || Number(row.source_link_index) !== input.linkIndex) {
          throw new ApiError(409, 'SOURCE_IDENTITY_MISMATCH', 'Nguồn bài không khớp file đã đọc.');
        }
      } else {
        const source = await client.query(`INSERT INTO writing_flow.source_record
          (source_type,source_app_id,source_table_id,source_record_id,homework_file_id,
           source_link_index,display_name,class_code,student_name,teacher_names,
           classroom_url,file_url,source_status,source_created_at,source_updated_at,
           metadata,dispatch_status,acknowledged_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
                  jsonb_build_object('trCcSource',$16::text),'acknowledged',now())
          ON CONFLICT (source_app_id,source_table_id,source_record_id,homework_file_id,source_link_index)
          DO UPDATE SET display_name=coalesce(EXCLUDED.display_name,writing_flow.source_record.display_name),
            class_code=coalesce(EXCLUDED.class_code,writing_flow.source_record.class_code),
            student_name=coalesce(EXCLUDED.student_name,writing_flow.source_record.student_name),
            teacher_names=CASE WHEN cardinality(EXCLUDED.teacher_names)>0
              THEN EXCLUDED.teacher_names ELSE writing_flow.source_record.teacher_names END,
            classroom_url=coalesce(EXCLUDED.classroom_url,writing_flow.source_record.classroom_url),
            file_url=coalesce(EXCLUDED.file_url,writing_flow.source_record.file_url),
            source_status=coalesce(EXCLUDED.source_status,writing_flow.source_record.source_status),
            source_updated_at=GREATEST(writing_flow.source_record.source_updated_at,EXCLUDED.source_updated_at),
            dispatch_status='acknowledged',acknowledged_at=now(),last_error_code=NULL,updated_at=now()
          RETURNING source_id`, [
          sourceType, input.appId, input.tableId, input.recordId, input.docId,
          input.linkIndex, sourceMeta.displayName || null, input.classCode,
          sourceMeta.studentName || null, sourceMeta.teacherNames || [],
          sourceMeta.classroomUrl || null, sourceMeta.fileUrl || null,
          sourceMeta.sourceStatus || null, sourceMeta.sourceCreatedAt || null,
          sourceModifiedAt, isLark ? 'lark' : sourceType,
        ]);
        sourceId = source.rows[0].source_id;
      }
      let testGroupId = null;
      if (sourceType === 'term_test') {
        const topology = prepared.some(pair => pair.taskType === 'task_1')
          ? 'task_1_and_task_2' : 'task_2_only';
        const group = await client.query(`INSERT INTO writing_flow.test_group
          (source_id,display_name,test_config,topology,note,created_by)
          VALUES ($1,$2,$3,$4,$5,$6)
          ON CONFLICT (source_id) DO UPDATE SET
            display_name=EXCLUDED.display_name,
            test_config=coalesce(writing_flow.test_group.test_config,EXCLUDED.test_config),
            topology=EXCLUDED.topology,
            note=coalesce(writing_flow.test_group.note,EXCLUDED.note),updated_at=now()
          RETURNING test_group_id`, [sourceId, sourceMeta.displayName || 'Bài Test Writing',
          sourceMeta.testConfig || null, topology, sourceMeta.note || null,
          sourceMeta.createdBy || 'system']);
        testGroupId = group.rows[0].test_group_id;
      }
      const receipts = [];
      for (const pair of prepared) {
        const scope = [input.appId, input.tableId, input.recordId,
          input.docId, input.linkIndex, pair.essaySlot];
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [JSON.stringify(scope)]);
        const current = await client.query(`
          SELECT pair_id, submission_revision, content_sha256, source_modified_at,
                 lark_modified_ms, status, trcc_required_override
            FROM writing_flow.pair
           WHERE source_app_id = $1 AND source_table_id = $2
             AND source_record_id = $3 AND homework_file_id = $4
             AND source_link_index = $5 AND essay_slot = $6
           ORDER BY source_modified_at DESC, lark_modified_ms DESC NULLS LAST, created_at DESC
           LIMIT 1`, scope);
        const newest = current.rows[0];
        if (newest && new Date(newest.source_modified_at).getTime() > modifiedMs) {
          receipts.push({ essaySlot: pair.essaySlot, pairId: newest.pair_id, status: 'stale_read' });
          continue;
        }
        const sameFileTime = newest
          && new Date(newest.source_modified_at).getTime() === modifiedMs;
        if (sameFileTime && newest.content_sha256 !== pair.contentSha256) {
          throw new ApiError(409, 'SOURCE_VERSION_CONFLICT',
            'Hai nội dung khác nhau có cùng phiên bản file.');
        }
        // Bài Classroom cũ có thể đã được cứu TR/CC bằng cờ vận hành riêng.
        // Khi file chỉ đổi vì hệ thống ghi lại link kết quả, nội dung đề–bài vẫn giữ nguyên:
        // nhận lượt quét mới là cùng bài, không tạo cặp mới và không chấm lại toàn bộ.
        const directTrccRepairEquivalent = newest && !isLark
          && newest.trcc_required_override === true
          && newest.content_sha256 === pair.contentSha256
          && pair.trCcCheck === true;
        if (directTrccRepairEquivalent) {
          await client.query(`UPDATE writing_flow.pair
            SET source_modified_at=GREATEST(source_modified_at,$2),updated_at=now()
            WHERE pair_id=$1`, [newest.pair_id, sourceModifiedAt]);
          receipts.push({ essaySlot: pair.essaySlot, pairId: newest.pair_id, status: 'existing' });
          continue;
        }
        if (sameFileTime && newest.submission_revision !== pair.revision && !isLark) {
          throw new ApiError(409, 'SOURCE_VERSION_CONFLICT',
            'Nguồn bài đổi nội dung nhưng chưa có phiên bản file mới.');
        }
        if (sameFileTime && newest.submission_revision !== pair.revision && isLark) {
          const previousLarkMs = newest.lark_modified_ms == null
            ? null : Number(newest.lark_modified_ms);
          if (previousLarkMs == null || !Number.isSafeInteger(previousLarkMs)) {
            throw new ApiError(409, 'SOURCE_POLICY_VERSION_UNKNOWN',
              'Chưa xác minh được thứ tự thay đổi cờ của hồ sơ Lark.');
          }
          if (previousLarkMs > larkModifiedMs) {
            receipts.push({ essaySlot: pair.essaySlot, pairId: newest.pair_id,
              status: 'stale_read' });
            continue;
          }
          if (previousLarkMs === larkModifiedMs) {
            throw new ApiError(409, 'SOURCE_POLICY_VERSION_CONFLICT',
              'Hai giá trị cờ khác nhau có cùng thời điểm sửa hồ sơ Lark.');
          }
        }
        if (newest?.submission_revision === pair.revision) {
          if (new Date(newest.source_modified_at).getTime() < modifiedMs
            || (isLark && Number(newest.lark_modified_ms ?? 0) < larkModifiedMs)) {
            await client.query(`
              UPDATE writing_flow.pair
                 SET source_modified_at = GREATEST(source_modified_at, $2),
                     lark_modified_ms = CASE WHEN $3::bigint IS NULL THEN lark_modified_ms
                       ELSE GREATEST(COALESCE(lark_modified_ms, 0), $3) END,
                     updated_at = now()
               WHERE pair_id = $1`, [newest.pair_id, sourceModifiedAt, larkModifiedMs]);
          }
          receipts.push({ essaySlot: pair.essaySlot, pairId: newest.pair_id,
            status: newest.status === 'superseded' ? 'stale_read' : 'existing' });
          continue;
        }
        await client.query(`
          UPDATE writing_flow.pair SET status = 'superseded', updated_at = now()
           WHERE source_app_id = $1 AND source_table_id = $2
             AND source_record_id = $3 AND homework_file_id = $4
             AND source_link_index = $5 AND essay_slot = $6
             AND status <> 'superseded'`, scope);
        const inserted = await client.query(`
          INSERT INTO writing_flow.pair
            (source_app_id, source_table_id, source_record_id,
             homework_file_id, source_link_index, essay_slot,
             submission_revision, source_modified_at, lark_modified_ms,
             content_sha256, class_code, task_type, document_kind,
             source_ciphertext, encryption_version,source_type,source_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,$15,$16)
          RETURNING pair_id`, [
          ...scope, pair.revision, sourceModifiedAt, larkModifiedMs,
          pair.contentSha256, input.classCode,
          pair.taskType, input.documentKind, pair.sourceCiphertext,sourceType,sourceId,
        ]);
        const pairId = inserted.rows[0].pair_id;
        const searchTokens = writingSearchTokens(pair.essay, key);
        if (searchTokens.length) {
          await client.query(`INSERT INTO writing_flow.pair_search_token (pair_id,token_hash)
            SELECT $1,token FROM unnest($2::bytea[]) AS token
            ON CONFLICT DO NOTHING`, [pairId, searchTokens]);
        }
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
        if (pair.alreadyGraded) {
          await client.query(`UPDATE writing_flow.pair
            SET status='delivered',finished_at=now(),updated_at=now()
            WHERE pair_id=$1`, [pairId]);
          receipts.push({ essaySlot: pair.essaySlot, pairId, status: 'existing',
            revision: pair.revision, historicalEvidence: true });
        } else {
          const handoff = await client.query(`
            INSERT INTO writing_flow.handoff
              (pair_id, from_stage, to_stage, source_result_sha256, next_send_at)
            VALUES ($1,'intake','precheck',$2,now()+interval '6 hours')
            RETURNING handoff_id`,
          [pairId, pair.resultSha256]);
          receipts.push({ essaySlot: pair.essaySlot, pairId, status: 'received',
            revision: pair.revision, handoffId: handoff.rows[0].handoff_id });
        }
      }
      if (receipts.length !== input.expectedCount) {
        throw new ApiError(500, 'INTAKE_READBACK_COUNT_MISMATCH', 'Chưa ghi đủ trạng thái các bài.');
      }
      if (testGroupId) {
        for (const receipt of receipts) {
          if (!receipt.pairId || !['received', 'existing'].includes(receipt.status)) continue;
          const preparedPair = prepared.find(item => item.essaySlot === receipt.essaySlot);
          const taskNumber = preparedPair?.taskType === 'task_1' ? 1 : 2;
          await client.query(`INSERT INTO writing_flow.test_pair
            (test_group_id,pair_id,task_number,status,delivered_at,historical_evidence)
            VALUES ($1,$2,$3,$4::text,CASE WHEN $4::text='delivered' THEN now() END,
              CASE WHEN $5::boolean THEN jsonb_build_object('source','google_docs_result_link') ELSE '{}'::jsonb END)
            ON CONFLICT (test_group_id,task_number) DO UPDATE SET pair_id=EXCLUDED.pair_id,
              status=EXCLUDED.status,delivered_at=EXCLUDED.delivered_at,
              historical_evidence=EXCLUDED.historical_evidence,updated_at=now()
            WHERE writing_flow.test_pair.pair_id IS DISTINCT FROM EXCLUDED.pair_id`,
          [testGroupId, receipt.pairId, taskNumber,
            receipt.historicalEvidence === true ? 'delivered' : 'pending',
            receipt.historicalEvidence === true]);
        }
        const groupState = await client.query(`SELECT count(*)::int AS total,
            count(*) FILTER (WHERE status='delivered')::int AS delivered
          FROM writing_flow.test_pair WHERE test_group_id=$1`, [testGroupId]);
        const { total, delivered } = groupState.rows[0];
        await client.query(`UPDATE writing_flow.test_group SET
          evidence_status=CASE WHEN $2::int>0 THEN 'already_graded' ELSE evidence_status END,
          status=CASE WHEN $1::int>0 AND $1::int=$2::int THEN 'complete' ELSE status END,
          completed_at=CASE WHEN $1::int>0 AND $1::int=$2::int THEN now() ELSE completed_at END,
          updated_at=now() WHERE test_group_id=$3`, [total, delivered, testGroupId]);
      }
      // Chỉ xóa lỗi đúng ô đã nhận; lỗi ô khác trong cùng file vẫn còn để xử lý.
      for (const receipt of receipts) {
        if (!['received', 'existing'].includes(receipt.status)) continue;
        await client.query(`UPDATE writing_flow.source_issue
          SET status='resolved',resolved_at=now(),last_seen_at=now()
          WHERE source_app_id=$1 AND source_table_id=$2
            AND source_record_id=$3 AND homework_file_id=$4
            AND source_link_index=$5 AND (essay_slot=$6 OR essay_slot IS NULL)
            AND status='open'`,
        [input.appId, input.tableId, input.recordId,
          input.docId, input.linkIndex, receipt.essaySlot]);
      }
      await client.query(`UPDATE writing_flow.source_record
        SET dispatch_status='acknowledged',acknowledged_at=now(),next_dispatch_at=NULL,
            last_error_code=NULL,updated_at=now()
        WHERE source_id=$1`, [sourceId]);
      return { detectedCount: input.expectedCount, registeredCount: receipts.length, receipts };
    });
  };
}
