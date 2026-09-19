import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { keyFromHex, open, seal, sha256 } from './writing-flow-crypto.js';

const STAGES = ['intake', 'precheck', 'main', 'critic', 'arbiter', 'render', 'deliver'];
const GOOGLE_DOC_ID = /^\/document\/d\/([A-Za-z0-9_-]{20,})(?:\/|$)/u;

function documentIdFromUrl(value) {
  const url = String(value || '').trim();
  if (!url.startsWith('https://')) return '';
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'docs.google.com') return '';
    return parsed.pathname.match(GOOGLE_DOC_ID)?.[1] || '';
  } catch {
    return '';
  }
}

function jsonObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// Dữ liệu nhận vào: pool PostgreSQL, khóa mã hóa và lệnh của quản trị viên đã xác thực.
// Việc chính: thêm nguồn thủ công, tải chi tiết, bỏ qua/khôi phục và retry đúng giai đoạn.
// Kết quả: mọi lệnh được ghi bằng request ID; dashboard chỉ nhận dữ liệu của đúng bài.
// Khi lỗi: transaction hoàn tác và trả mã rõ ràng; không ghi Lark Base hay sửa Google Docs.
export function createWritingFlowOperations({ pool, encryptionKey = null }) {
  const key = keyFromHex(encryptionKey);

  async function existingEvent(client, requestId) {
    const result = await client.query(`SELECT event_id,pair_id,source_id,event_type,after_state
      FROM writing_flow.operator_event WHERE request_id=$1`, [requestId]);
    return result.rows[0] || null;
  }

  return {
    async upsertClassRegistry({ classes }) {
      return withTransaction(pool, async client => {
        const rows = [];
        for (const item of classes) {
          const result = await client.query(`INSERT INTO writing_flow.class_registry
            (class_code,classroom_course_id,classroom_name,cohort,teacher_names,enabled,source_ref,
             scan_status,next_scan_at,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,'lark_read_only','pending',now(),now())
            ON CONFLICT (class_code) DO UPDATE SET
              classroom_course_id=EXCLUDED.classroom_course_id,
              classroom_name=EXCLUDED.classroom_name,cohort=EXCLUDED.cohort,
              teacher_names=EXCLUDED.teacher_names,enabled=EXCLUDED.enabled,
              next_scan_at=CASE WHEN writing_flow.class_registry.classroom_course_id
                IS DISTINCT FROM EXCLUDED.classroom_course_id THEN now()
                ELSE writing_flow.class_registry.next_scan_at END,
              scan_status=CASE WHEN writing_flow.class_registry.classroom_course_id
                IS DISTINCT FROM EXCLUDED.classroom_course_id THEN 'pending'
                ELSE writing_flow.class_registry.scan_status END,updated_at=now()
            RETURNING class_code,classroom_course_id,classroom_name,cohort,teacher_names,
              enabled,scan_status,next_scan_at,last_scan_at,last_error_code`,
          [item.classCode, item.courseId, item.courseName || null, item.cohort || null,
            item.teacherNames || [], item.enabled !== false]);
          rows.push(result.rows[0]);
        }
        return rows;
      });
    },

    async claimDueClasses({ limit = 20 } = {}) {
      return withTransaction(pool, async client => {
        const due = await client.query(`SELECT class_code FROM writing_flow.class_registry
          WHERE enabled AND scan_status IN ('pending','scanning','succeeded','failed') AND next_scan_at<=now()
          ORDER BY next_scan_at,class_code FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]);
        if (!due.rowCount) return [];
        const codes = due.rows.map(row => row.class_code);
        const result = await client.query(`UPDATE writing_flow.class_registry
          SET scan_status='scanning',next_scan_at=now()+interval '10 minutes',updated_at=now()
          WHERE class_code=ANY($1::text[])
          RETURNING class_code,classroom_course_id,classroom_name,cohort,teacher_names`, [codes]);
        return result.rows;
      });
    },

    async acknowledgeClassScan({ classCode, outcome, errorCode = null }) {
      const result = await pool.query(`UPDATE writing_flow.class_registry
        SET scan_status=CASE WHEN $2='succeeded' THEN 'succeeded' ELSE 'failed' END,
            last_scan_at=now(),last_error_code=$3,next_scan_at=now()+
              CASE WHEN $2='succeeded' THEN interval '10 minutes' ELSE interval '2 minutes' END,
            updated_at=now() WHERE class_code=$1
        RETURNING class_code,scan_status,last_scan_at,next_scan_at,last_error_code`,
      [classCode, outcome, errorCode]);
      if (!result.rowCount) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Không tìm thấy lớp cần quét.');
      return result.rows[0];
    },

    async requestClassScan({ classCode, requestId, actorRef, reason }) {
      return withTransaction(pool, async client => {
        const duplicate = await existingEvent(client, requestId);
        if (duplicate) return { classCode, status: 'pending', requestId };
        const result = await client.query(`UPDATE writing_flow.class_registry
          SET scan_status='pending',next_scan_at=now(),last_error_code=NULL,updated_at=now()
          WHERE class_code=$1 AND enabled RETURNING class_code`, [classCode]);
        if (!result.rowCount) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Không tìm thấy lớp đang vận hành.');
        await client.query(`INSERT INTO writing_flow.operator_event
          (class_code,event_type,actor_ref,request_id,reason,after_state)
          VALUES ($1,'class_scan_requested',$2,$3,$4,'{"scanStatus":"pending"}'::jsonb)`,
        [classCode, actorRef, requestId, reason]);
        return { classCode, status: 'pending', requestId };
      });
    },

    async upsertClassroomSources({ sources }) {
      return withTransaction(pool, async client => {
        const rows = [];
        for (const item of sources) {
          const snapshot = { submissionId: item.submissionId, courseWorkId: item.courseWorkId,
            submissionState: item.sourceStatus, alternateLink: item.classroomUrl };
          const result = await client.query(`INSERT INTO writing_flow.source_record
            (source_type,source_app_id,source_table_id,source_record_id,homework_file_id,
             source_link_index,display_name,class_code,student_name,teacher_names,
             classroom_url,file_url,source_status,source_created_at,source_updated_at,
             metadata,dispatch_status,next_dispatch_at)
            VALUES ('google_classroom','google_classroom',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                    $12,$13,$14::jsonb,'pending',now())
            ON CONFLICT (source_app_id,source_table_id,source_record_id,homework_file_id,source_link_index)
            DO UPDATE SET display_name=EXCLUDED.display_name,class_code=EXCLUDED.class_code,
              student_name=EXCLUDED.student_name,teacher_names=EXCLUDED.teacher_names,
              classroom_url=EXCLUDED.classroom_url,file_url=EXCLUDED.file_url,
              source_status=EXCLUDED.source_status,source_created_at=EXCLUDED.source_created_at,
              source_updated_at=GREATEST(writing_flow.source_record.source_updated_at,EXCLUDED.source_updated_at),
              metadata=EXCLUDED.metadata,
              dispatch_status=CASE WHEN writing_flow.source_record.source_updated_at IS DISTINCT FROM EXCLUDED.source_updated_at
                OR writing_flow.source_record.metadata IS DISTINCT FROM EXCLUDED.metadata
                THEN 'pending' ELSE writing_flow.source_record.dispatch_status END,
              next_dispatch_at=CASE WHEN writing_flow.source_record.source_updated_at IS DISTINCT FROM EXCLUDED.source_updated_at
                OR writing_flow.source_record.metadata IS DISTINCT FROM EXCLUDED.metadata
                THEN now() ELSE writing_flow.source_record.next_dispatch_at END,updated_at=now()
            RETURNING source_id,dispatch_status,source_record_id,homework_file_id,source_link_index`,
          [item.courseId, item.submissionId, item.documentId, item.linkIndex, item.displayName || null,
            item.classCode, item.studentName || null, item.teacherNames || [], item.classroomUrl || null,
            item.fileUrl, item.sourceStatus || null, item.sourceCreatedAt || null,
            item.sourceUpdatedAt, JSON.stringify(snapshot)]);
          rows.push(result.rows[0]);
        }
        return rows;
      });
    },

    async importLegacyRecords({ records, actorRef }) {
      if (!key) throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY',
        'Chưa cấu hình nơi nhập lịch sử.');
      return withTransaction(pool, async client => {
        let imported = 0;
        for (const item of records) {
          const snapshotJson = JSON.stringify(item.snapshot || {});
          const digest = sha256(snapshotJson);
          const result = await client.query(`INSERT INTO writing_flow.legacy_record
            (source_app_id,source_table_id,source_record_id,essay_slot,class_code,
             student_name,teacher_name,source_status,created_at_source,finished_at_source,
             snapshot_sha256,snapshot_ciphertext)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            ON CONFLICT DO NOTHING RETURNING legacy_id`,
          [item.appId, item.tableId, item.recordId, item.essaySlot || null, item.classCode || null,
            item.studentName || null, item.teacherName || null, item.sourceStatus || null,
            item.createdAt || null, item.finishedAt || null, digest, seal(snapshotJson, key)]);
          imported += result.rowCount;
        }
        return { imported, received: records.length };
      });
    },

    async listLegacyRecords({ classCode = null, limit = 50, offset = 0 } = {}) {
      const result = await pool.query(`SELECT legacy_id,source_record_id,essay_slot,class_code,
          student_name,teacher_name,source_status,created_at_source,finished_at_source,
          linked_pair_id,match_status,imported_at
        FROM writing_flow.legacy_record WHERE ($1::text IS NULL OR class_code=$1)
        ORDER BY coalesce(created_at_source,imported_at) DESC,legacy_id DESC LIMIT $2 OFFSET $3`,
      [classCode, limit, offset]);
      return result.rows;
    },

    async addManualSource({ displayName, documentUrl, requestId, actorRef }) {
      const fileId = documentIdFromUrl(documentUrl);
      if (!fileId) {
        throw new ApiError(400, 'MANUAL_GOOGLE_DOC_INVALID',
          'Link phải là một file Google Docs hợp lệ.');
      }
      const name = String(displayName || '').trim();
      if (name.length < 2) {
        throw new ApiError(400, 'MANUAL_NAME_REQUIRED', 'Cần nhập tên để nhận biết bài thủ công.');
      }
      return withTransaction(pool, async client => {
        const duplicate = await existingEvent(client, requestId);
        if (duplicate) {
          const source = await client.query(`SELECT source_id,display_name,file_url,dispatch_status,
              dispatch_count,last_error_code,created_at,updated_at
            FROM writing_flow.source_record WHERE source_id=$1`, [duplicate.source_id]);
          return source.rows[0];
        }
        const recordId = crypto.randomUUID();
        const canonicalUrl = `https://docs.google.com/document/d/${fileId}/edit`;
        const inserted = await client.query(`INSERT INTO writing_flow.source_record
          (source_type,source_app_id,source_table_id,source_record_id,homework_file_id,
           source_link_index,display_name,class_code,file_url,source_status,metadata,
           dispatch_status,next_dispatch_at,created_by)
          VALUES ('manual','manual_dashboard','manual:' || $1,$1,$2,1,$3,'MANUAL',$4,
                  'SUBMITTED',jsonb_build_object('manualName',$3),'pending',now(),$5)
          RETURNING source_id,display_name,file_url,dispatch_status,dispatch_count,
                    last_error_code,created_at,updated_at`,
        [recordId, fileId, name, canonicalUrl, actorRef]);
        const source = inserted.rows[0];
        await client.query(`INSERT INTO writing_flow.operator_event
          (source_id,event_type,actor_ref,request_id,reason,after_state)
          VALUES ($1,'manual_source_added',$2,$3,$4,$5::jsonb)`,
        [source.source_id, actorRef, requestId, name,
          JSON.stringify({ dispatchStatus: source.dispatch_status })]);
        return source;
      });
    },

    async claimDueSources({ sourceTypes = ['manual', 'google_classroom'], limit = 50 } = {}) {
      return withTransaction(pool, async client => {
        const due = await client.query(`SELECT s.source_id
          FROM writing_flow.source_record s
          WHERE s.source_type = ANY($1::text[])
            AND s.dispatch_status IN ('pending','sent')
            AND coalesce(s.next_dispatch_at,now()) <= now()
            AND NOT EXISTS (
              SELECT 1 FROM writing_flow.scan_run r
              WHERE r.status='open'
                AND r.source_app_id=s.source_app_id
                AND r.source_table_id=s.source_table_id)
          ORDER BY s.next_dispatch_at NULLS FIRST,s.created_at,s.source_id
          FOR UPDATE OF s SKIP LOCKED LIMIT $2`, [sourceTypes, limit]);
        if (!due.rowCount) return [];
        const ids = due.rows.map(row => row.source_id);
        const result = await client.query(`UPDATE writing_flow.source_record
          SET dispatch_status='sent',dispatch_count=dispatch_count+1,last_dispatched_at=now(),
              next_dispatch_at=now()+interval '2 minutes',updated_at=now()
          WHERE source_id=ANY($1::uuid[])
          RETURNING source_id,source_type,source_app_id,source_table_id,source_record_id,
            homework_file_id,source_link_index,display_name,class_code,student_name,
            teacher_names,classroom_url,file_url,source_status,source_created_at,
            source_updated_at,metadata,dispatch_count`, [ids]);
        return result.rows;
      });
    },

    async acknowledgeSource({ sourceId, outcome, errorCode = null }) {
      const status = outcome === 'accepted' ? 'acknowledged'
        : outcome === 'excluded' ? 'excluded' : 'needs_review';
      const result = await pool.query(`UPDATE writing_flow.source_record
        SET dispatch_status=$2,acknowledged_at=CASE WHEN $2='acknowledged' THEN now() ELSE acknowledged_at END,
            next_dispatch_at=NULL,last_error_code=$3,updated_at=now()
        WHERE source_id=$1
        RETURNING source_id,dispatch_status,dispatch_count,last_error_code,updated_at`,
      [sourceId, status, errorCode]);
      if (!result.rowCount) throw new ApiError(404, 'SOURCE_NOT_FOUND', 'Không tìm thấy nguồn bài.');
      return result.rows[0];
    },

    async listSources({ sourceType = null, status = null, limit = 50, cursorAt = null,
      cursorId = null } = {}) {
      const result = await pool.query(`SELECT source_id,source_type,display_name,class_code,
          student_name,teacher_names,classroom_url,file_url,source_status,
          dispatch_status,dispatch_count,last_error_code,source_created_at,
          source_updated_at,created_at,updated_at
        FROM writing_flow.source_record
        WHERE ($1::text IS NULL OR source_type=$1)
          AND ($2::text IS NULL OR dispatch_status=$2)
          AND ($3::timestamptz IS NULL OR (updated_at,source_id) < ($3::timestamptz,$4::uuid))
        ORDER BY updated_at DESC,source_id DESC LIMIT $5`,
      [sourceType, status, cursorAt, cursorId, limit]);
      return result.rows;
    },

    async pairDetail({ pairId }) {
      if (!key) throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY',
        'Chưa cấu hình nơi đọc nội dung bài chấm.');
      const pair = await pool.query(`SELECT p.pair_id,p.class_code,p.task_type,p.essay_slot,
          p.status,p.source_type,p.source_app_id,p.source_table_id,p.source_record_id,
          p.homework_file_id,p.source_link_index,p.source_modified_at,p.created_at,p.updated_at,
          p.skipped_at,p.skipped_by,p.skip_reason,p.finished_at,p.source_ciphertext,
          s.source_id,s.display_name,s.student_name,s.teacher_names,s.classroom_url,
          s.file_url,s.source_status,s.source_created_at
        FROM writing_flow.pair AS p
        LEFT JOIN writing_flow.source_record AS s ON s.source_id=p.source_id
        WHERE p.pair_id=$1`, [pairId]);
      if (!pair.rowCount) throw new ApiError(404, 'WRITING_PAIR_NOT_FOUND', 'Không tìm thấy bài này.');
      let source;
      try {
        const decoded = JSON.parse(open(pair.rows[0].source_ciphertext, key));
        source = { taskType: decoded[0], topic: decoded[1], image: decoded[2],
          essay: decoded[3], trCcCheck: decoded[4] };
      } catch {
        throw new ApiError(500, 'WRITING_SOURCE_DECRYPT_FAILED', 'Chưa đọc được nội dung bài đã lưu.');
      }
      const stages = await pool.query(`SELECT stage_key,status,cycle_no,attempt_count,error_code,
          n8n_execution_id,started_at,completed_at,updated_at,result_ciphertext
        FROM writing_flow.stage_result WHERE pair_id=$1
        ORDER BY array_position($2::text[],stage_key)`, [pairId, STAGES]);
      const stageRows = stages.rows.map(row => {
        let result = null;
        if (row.result_ciphertext) {
          try { result = jsonObject(JSON.parse(open(row.result_ciphertext, key))); } catch { result = null; }
        }
        const { result_ciphertext: _hidden, ...safe } = row;
        return { ...safe, result };
      });
      const { source_ciphertext: _ciphertext, ...safePair } = pair.rows[0];
      return { pair: safePair, source, stages: stageRows };
    },

    async skipPair({ pairId, requestId, actorRef, reason }) {
      return withTransaction(pool, async client => {
        const duplicate = await existingEvent(client, requestId);
        if (duplicate) return { pairId, status: 'skipped', requestId };
        const found = await client.query(`SELECT pair_id,status,skipped_at
          FROM writing_flow.pair WHERE pair_id=$1 FOR UPDATE`, [pairId]);
        if (!found.rowCount) throw new ApiError(404, 'WRITING_PAIR_NOT_FOUND', 'Không tìm thấy bài này.');
        if (found.rows[0].skipped_at) throw new ApiError(409, 'PAIR_ALREADY_SKIPPED', 'Bài đã được bỏ qua.');
        const stage = await client.query(`SELECT stage_key,status FROM writing_flow.stage_result
          WHERE pair_id=$1 AND status IN ('running','pending','needs_review')
          ORDER BY array_position($2::text[],stage_key) LIMIT 1`, [pairId, STAGES]);
        const before = { pairStatus: found.rows[0].status,
          stageKey: stage.rows[0]?.stage_key || 'deliver', stageStatus: stage.rows[0]?.status || 'succeeded' };
        await client.query(`UPDATE writing_flow.pair
          SET skipped_at=now(),skipped_by=$2,skip_reason=$3,skip_previous_status=status,updated_at=now()
          WHERE pair_id=$1`, [pairId, actorRef, reason]);
        await client.query(`INSERT INTO writing_flow.operator_event
          (pair_id,event_type,actor_ref,request_id,reason,before_state,after_state)
          VALUES ($1,'skipped',$2,$3,$4,$5::jsonb,'{"skipped":true}'::jsonb)`,
        [pairId, actorRef, requestId, reason, JSON.stringify(before)]);
        return { pairId, status: 'skipped', requestId };
      });
    },

    async restorePair({ pairId, requestId, actorRef, reason }) {
      return withTransaction(pool, async client => {
        const duplicate = await existingEvent(client, requestId);
        if (duplicate) return { pairId, status: 'restored', requestId };
        const found = await client.query(`SELECT pair_id,status,skipped_at,skip_previous_status
          FROM writing_flow.pair WHERE pair_id=$1 FOR UPDATE`, [pairId]);
        if (!found.rowCount) throw new ApiError(404, 'WRITING_PAIR_NOT_FOUND', 'Không tìm thấy bài này.');
        if (!found.rows[0].skipped_at) throw new ApiError(409, 'PAIR_NOT_SKIPPED', 'Bài không ở trạng thái bỏ qua.');
        await client.query(`UPDATE writing_flow.pair
          SET skipped_at=NULL,skipped_by=NULL,skip_reason=NULL,skip_previous_status=NULL,updated_at=now()
          WHERE pair_id=$1`, [pairId]);
        await client.query(`INSERT INTO writing_flow.operator_event
          (pair_id,event_type,actor_ref,request_id,reason,before_state,after_state)
          VALUES ($1,'restored',$2,$3,$4,'{"skipped":true}'::jsonb,
                  jsonb_build_object('pairStatus',$5))`,
        [pairId, actorRef, requestId, reason, found.rows[0].skip_previous_status || found.rows[0].status]);
        return { pairId, status: 'restored', requestId };
      });
    },

    async requestStageRetry({ pairId, stageKey, requestId, actorRef, reason }) {
      const stageIndex = STAGES.indexOf(stageKey);
      if (stageIndex < 1) throw new ApiError(400, 'STAGE_RETRY_INVALID', 'Không thể chạy lại bước này.');
      return withTransaction(pool, async client => {
        const duplicate = await existingEvent(client, requestId);
        if (duplicate) return { pairId, stageKey, status: 'retry_requested', requestId };
        const pair = await client.query(`SELECT pair_id,status,skipped_at
          FROM writing_flow.pair WHERE pair_id=$1 FOR UPDATE`, [pairId]);
        if (!pair.rowCount) throw new ApiError(404, 'WRITING_PAIR_NOT_FOUND', 'Không tìm thấy bài này.');
        if (pair.rows[0].skipped_at) throw new ApiError(409, 'PAIR_SKIPPED', 'Hãy khôi phục bài trước khi retry.');
        const stages = await client.query(`SELECT stage_key,status,cycle_no,attempt_count,input_sha256,
            result_sha256,error_code
          FROM writing_flow.stage_result WHERE pair_id=$1 FOR UPDATE`, [pairId]);
        const target = stages.rows.find(row => row.stage_key === stageKey);
        if (!target) throw new ApiError(409, 'STAGE_NOT_READY', 'Bước này chưa được tạo.');
        if (!['succeeded','needs_review'].includes(target.status)) {
          throw new ApiError(409, 'STAGE_STILL_AUTOMATIC', 'Bước này đang chờ hệ thống tự xử lý.');
        }
        const commandHash = crypto.createHash('sha256').update(requestId).digest('hex');
        const invalidated = stages.rows.filter(row => STAGES.indexOf(row.stage_key) >= stageIndex)
          .map(row => ({ stageKey: row.stage_key, status: row.status, cycleNo: row.cycle_no }));
        await client.query(`UPDATE writing_flow.stage_result
          SET status='pending',cycle_no=cycle_no+1,attempt_count=0,result_sha256=NULL,
              result_ciphertext=NULL,selected_attempt_no=NULL,error_code=NULL,
              n8n_execution_id=NULL,started_at=NULL,lease_expires_at=NULL,
              completed_at=NULL,updated_at=now()
          WHERE pair_id=$1 AND array_position($2::text[],stage_key) >= $3`,
        [pairId, STAGES, stageIndex + 1]);
        await client.query(`UPDATE writing_flow.manual_review SET status='resolved',resolved_at=now()
          WHERE pair_id=$1 AND status<>'resolved'`, [pairId]);
        await client.query(`UPDATE writing_flow.handoff SET status='acknowledged',acknowledged_at=now(),
          error_code='SUPERSEDED_BY_OPERATOR_RETRY'
          WHERE pair_id=$1 AND status IN ('pending','sent','needs_review')`, [pairId]);
        await client.query(`INSERT INTO writing_flow.handoff
          (pair_id,from_stage,to_stage,source_result_sha256,status,next_send_at)
          VALUES ($1,'retry',$2,$3,'pending',now())`, [pairId, stageKey, commandHash]);
        await client.query(`UPDATE writing_flow.pair SET status='running',finished_at=NULL,updated_at=now()
          WHERE pair_id=$1`, [pairId]);
        await client.query(`INSERT INTO writing_flow.operator_event
          (pair_id,event_type,actor_ref,request_id,reason,before_state,after_state)
          VALUES ($1,'rerun_requested',$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [pairId, actorRef, requestId, reason, JSON.stringify({ invalidated }),
          JSON.stringify({ stageKey, status: 'retry_requested' })]);
        return { pairId, stageKey, status: 'retry_requested', requestId,
          invalidatedStages: invalidated.map(item => item.stageKey) };
      });
    },
  };
}

export { documentIdFromUrl, STAGES };
