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

// Nhận vào: tên bài tập Classroom.
// Việc chính: nhận đúng các biến thể Term Test/Mid Test/Final Test nhưng không đoán từ bài Writing thường.
// Trả ra: loại nguồn để dashboard và luồng chấm Test tách riêng mà vẫn dùng chung bảy giai đoạn.
export function classifyWritingSourceType(displayName) {
  const value = String(displayName || '').normalize('NFKC').toLocaleLowerCase('vi')
    .replace(/[_-]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return /\b(term|mid|final)\s*test\b/u.test(value) || /thi\s*(giữa|cuối)\s*kỳ/u.test(value)
    ? 'term_test' : 'google_classroom';
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
        // Một lượt quét đã hết lease ba lần phải dừng ở danh sách cần xử lý.
        // Không để lịch sau tiếp tục gọi Google cho cùng lớp vô hạn.
        await client.query(`UPDATE writing_flow.class_registry
          SET scan_status='needs_review',last_error_code=coalesce(last_error_code,'CLASS_SCAN_TIMEOUT'),
              next_scan_at=now()+interval '100 years',updated_at=now()
          WHERE enabled AND scan_status='scanning' AND next_scan_at<=now()
            AND scan_attempt_count>=3`);
        // Google mặc định cho 20 query/giây trên mỗi người dùng. Mỗi lớp gọi tối đa
        // một request/giây, nên chỉ giữ tám lớp đang quét để còn dư tải cho thao tác tay.
        const due = await client.query(`WITH capacity AS (
          SELECT greatest(0,8-count(*) FILTER (WHERE scan_status='scanning'
            AND next_scan_at>now()))::integer AS slots
          FROM writing_flow.class_registry
        ) SELECT class_code FROM writing_flow.class_registry
          WHERE enabled AND mapping_status='approved' AND eligibility_reason='active'
            AND scan_status IN ('pending','scanning','succeeded','failed') AND next_scan_at<=now()
          ORDER BY next_scan_at,class_code FOR UPDATE SKIP LOCKED
          LIMIT least($1,(SELECT slots FROM capacity))`, [limit]);
        if (!due.rowCount) return [];
        const codes = due.rows.map(row => row.class_code);
        const result = await client.query(`UPDATE writing_flow.class_registry
          SET scan_status='scanning',scan_attempt_count=least(scan_attempt_count+1,3),
              next_scan_at=now()+interval '20 minutes',updated_at=now()
          WHERE class_code=ANY($1::text[])
          RETURNING class_code,classroom_course_id,classroom_name,cohort,teacher_names,
            scan_attempt_count`, [codes]);
        return result.rows;
      });
    },

    async acknowledgeClassScan({ classCode, outcome, errorCode = null }) {
      const result = await pool.query(`UPDATE writing_flow.class_registry
        SET scan_status=CASE
              WHEN $2='succeeded' THEN 'succeeded'
              WHEN scan_attempt_count>=3 THEN 'needs_review'
              ELSE 'failed' END,
            last_scan_at=now(),last_error_code=$3,next_scan_at=now()+
              CASE
                WHEN $2='succeeded' THEN CASE
                  WHEN (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::time < time '12:00'
                    THEN ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + time '12:00')
                      AT TIME ZONE 'Asia/Ho_Chi_Minh' - now()
                  WHEN (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::time < time '17:00'
                    THEN ((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + time '17:00')
                      AT TIME ZONE 'Asia/Ho_Chi_Minh' - now()
                  ELSE (((now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 1) + time '05:00')
                      AT TIME ZONE 'Asia/Ho_Chi_Minh' - now() END
                WHEN scan_attempt_count>=3 THEN interval '100 years'
                -- Chờ 1, 2 hoặc 4 phút rồi cộng 0-30 giây ngẫu nhiên.
                -- Độ lệch nhỏ này tránh nhiều lớp lỗi cùng lúc cùng gọi lại Google.
                ELSE make_interval(secs => (
                  60 * power(2, greatest(scan_attempt_count-1,0))
                  + floor(random() * 31)
                )::integer)
              END,
            scan_attempt_count=CASE WHEN $2='succeeded' THEN 0 ELSE scan_attempt_count END,
            updated_at=now() WHERE class_code=$1
        RETURNING class_code,scan_status,scan_attempt_count,last_scan_at,next_scan_at,last_error_code`,
      [classCode, outcome, errorCode]);
      if (!result.rowCount) throw new ApiError(404, 'CLASS_NOT_FOUND', 'Không tìm thấy lớp cần quét.');
      return result.rows[0];
    },

    async requestClassScan({ classCode, requestId, actorRef, reason }) {
      return withTransaction(pool, async client => {
        const duplicate = await existingEvent(client, requestId);
        if (duplicate) return { classCode, status: 'pending', requestId };
        const result = await client.query(`UPDATE writing_flow.class_registry
          SET scan_status='pending',scan_attempt_count=0,next_scan_at=now(),
              last_error_code=NULL,updated_at=now()
          WHERE class_code=$1 AND enabled AND mapping_status='approved'
            AND eligibility_reason='active' RETURNING class_code`, [classCode]);
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
          const sourceType = classifyWritingSourceType(item.displayName);
          const result = await client.query(`INSERT INTO writing_flow.source_record
            (source_type,source_app_id,source_table_id,source_record_id,homework_file_id,
             source_link_index,display_name,class_code,student_name,teacher_names,
             classroom_url,file_url,source_status,source_created_at,source_updated_at,
             metadata,dispatch_status,next_dispatch_at)
            VALUES ($15,'google_classroom',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
                    $12,$13,$14::jsonb,'pending',now())
            ON CONFLICT (source_app_id,source_table_id,source_record_id,homework_file_id,source_link_index)
            DO UPDATE SET source_type=EXCLUDED.source_type,
              display_name=EXCLUDED.display_name,class_code=EXCLUDED.class_code,
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
            item.sourceUpdatedAt, JSON.stringify(snapshot), sourceType]);
          rows.push(result.rows[0]);
        }
        // Nguồn Lark chỉ còn dùng trong giai đoạn chuyển đổi. Khi Docs ID khớp duy nhất
        // một bài Classroom, bổ sung tên homework và metadata để dashboard không còn ô trống.
        const updatedDocumentIds = [...new Set(sources.map(item => item.documentId).filter(Boolean))];
        if (updatedDocumentIds.length) await client.query(`WITH classroom_candidate AS (
            SELECT source_id,homework_file_id,display_name,student_name,teacher_names,classroom_url,
              source_status,source_created_at,metadata,
              count(*) OVER (PARTITION BY homework_file_id) AS match_count
            FROM writing_flow.source_record
            WHERE source_type='google_classroom' AND homework_file_id=ANY($1::text[])
          ), unique_classroom AS (SELECT * FROM classroom_candidate WHERE match_count=1)
          UPDATE writing_flow.source_record AS legacy
          SET display_name=coalesce(nullif(legacy.display_name,''),source.display_name),
              student_name=coalesce(nullif(legacy.student_name,''),source.student_name),
              teacher_names=CASE WHEN cardinality(legacy.teacher_names)=0
                THEN source.teacher_names ELSE legacy.teacher_names END,
              classroom_url=coalesce(nullif(legacy.classroom_url,''),source.classroom_url),
              source_status=coalesce(nullif(legacy.source_status,''),source.source_status),
              source_created_at=coalesce(legacy.source_created_at,source.source_created_at),
              metadata=legacy.metadata || jsonb_build_object(
                'classroomBackfillSourceId',source.source_id::text,
                'classroomBackfilledAt',to_jsonb(now())),updated_at=now()
          FROM unique_classroom AS source
          WHERE legacy.source_type='lark_homework'
            AND legacy.homework_file_id=ANY($1::text[])
            AND legacy.homework_file_id=source.homework_file_id
            AND (nullif(legacy.display_name,'') IS NULL OR nullif(legacy.student_name,'') IS NULL
              OR cardinality(legacy.teacher_names)=0 OR nullif(legacy.classroom_url,'') IS NULL
              OR nullif(legacy.source_status,'') IS NULL OR legacy.source_created_at IS NULL)`,
        [updatedDocumentIds]);
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
          [item.appId, item.tableId, item.recordId, item.essaySlot ?? null, item.classCode || null,
            item.studentName || null, item.teacherName || null, item.sourceStatus || null,
            item.createdAt || null, item.finishedAt || null, digest, seal(snapshotJson, key)]);
          imported += result.rowCount;
        }
        return { imported, received: records.length };
      });
    },

    async listLegacyRecords({ classCode = null, limit = 50, offset = 0 } = {}) {
      if (!key) throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY',
        'Chưa cấu hình nơi đọc lịch sử.');
      const result = await pool.query(`SELECT * FROM (
          SELECT DISTINCT ON (legacy.source_app_id,legacy.source_table_id,
              legacy.source_record_id,legacy.essay_slot)
            legacy.legacy_id,legacy.source_record_id,legacy.essay_slot,legacy.class_code,
            legacy.student_name,legacy.teacher_name,legacy.source_status,
            legacy.created_at_source,legacy.finished_at_source,legacy.linked_pair_id,
            legacy.match_status,legacy.imported_at,legacy.snapshot_ciphertext
          FROM writing_flow.legacy_record AS legacy
          LEFT JOIN writing_flow.class_registry AS registry
            ON registry.class_code=legacy.class_code
          WHERE ($1::text IS NULL OR legacy.class_code=$1)
            AND (registry.class_code IS NULL OR coalesce(registry.eligibility_reason,'')
              NOT IN ('excluded','excluded_ic_before_2065','excluded_ic_program'))
            AND (legacy.essay_slot IS NOT NULL OR NOT EXISTS (
              SELECT 1 FROM writing_flow.legacy_record AS slotted
              WHERE slotted.source_app_id=legacy.source_app_id
                AND slotted.source_table_id=legacy.source_table_id
                AND slotted.source_record_id=legacy.source_record_id
                AND slotted.essay_slot IS NOT NULL))
          ORDER BY legacy.source_app_id,legacy.source_table_id,legacy.source_record_id,
            legacy.essay_slot,legacy.imported_at DESC,legacy.legacy_id DESC
        ) AS latest
        ORDER BY coalesce(created_at_source,imported_at) DESC,legacy_id DESC LIMIT $2 OFFSET $3`,
      [classCode, limit, offset]);
      return result.rows.map(row => {
        let snapshot = {};
        let dataIssueCode = null;
        try { snapshot = JSON.parse(open(row.snapshot_ciphertext, key)); }
        catch { dataIssueCode = 'LEGACY_DECRYPT_FAILED'; }
        const { snapshot_ciphertext: _hidden, ...safe } = row;
        return { ...safe, homework_title: snapshot.homeworkTitle || null,
          classroom_url: snapshot.classroomUrl || null, file_url: snapshot.fileUrl || null,
          topic: snapshot.topic || null, image_url: snapshot.image || null,
          essay_preview: String(snapshot.essay || '').slice(0, 420) || null,
          tr_cc_check: snapshot.trcc ?? null, lms_url: snapshot.lms || null,
          data_issue_code: dataIssueCode };
      });
    },

    async addManualSource({ displayName, documentUrl, requestId, actorRef,
      kind = 'homework', testConfig = null, topology = null, note = null }) {
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
        const isTest = kind === 'test';
        const sourceType = isTest ? 'term_test' : 'manual';
        const normalizedTopology = isTest ? topology : null;
        const metadata = isTest
          ? { manualName: name, testConfig, topology: normalizedTopology, note }
          : { manualName: name };
        const inserted = await client.query(`INSERT INTO writing_flow.source_record
          (source_type,source_app_id,source_table_id,source_record_id,homework_file_id,
           source_link_index,display_name,class_code,file_url,source_status,metadata,
           dispatch_status,next_dispatch_at,created_by)
          VALUES ($6,'manual_dashboard','manual:' || $1,$1,$2,1,$3,'MANUAL',$4,
                  'SUBMITTED',$7::jsonb,'pending',now(),$5)
          RETURNING source_id,display_name,file_url,dispatch_status,dispatch_count,
                    last_error_code,created_at,updated_at`,
        [recordId, fileId, name, canonicalUrl, actorRef, sourceType, JSON.stringify(metadata)]);
        const source = inserted.rows[0];
        if (isTest) {
          await client.query(`INSERT INTO writing_flow.test_group
            (source_id,display_name,test_config,topology,note,created_by)
            VALUES ($1,$2,$3,$4,$5,$6)`,
          [source.source_id, name, testConfig, normalizedTopology, note, actorRef]);
        }
        await client.query(`INSERT INTO writing_flow.operator_event
          (source_id,event_type,actor_ref,request_id,reason,after_state)
          VALUES ($1,$6,$2,$3,$4,$5::jsonb)`,
        [source.source_id, actorRef, requestId, name,
          JSON.stringify({ dispatchStatus: source.dispatch_status, kind }),
          isTest ? 'manual_test_added' : 'manual_source_added']);
        return source;
      });
    },

    async claimDueSources({ sourceTypes = ['manual', 'google_classroom', 'term_test'], limit = 50 } = {}) {
      return withTransaction(pool, async client => {
        const due = await client.query(`WITH capacity AS (
          SELECT greatest(0,100-count(*))::int AS available
          FROM writing_flow.source_record queued
          WHERE queued.source_type = ANY($1::text[])
            AND queued.dispatch_status='sent'
            AND queued.last_dispatched_at > now()-interval '6 hours'
        )
        SELECT s.source_id
          FROM writing_flow.source_record s
          WHERE s.source_type = ANY($1::text[])
            AND s.dispatch_status IN ('pending','sent')
            AND coalesce(s.next_dispatch_at,now()) <= now()
            AND (s.dispatch_status='pending'
              OR coalesce(s.last_dispatched_at,'-infinity'::timestamptz)
                 <= now()-interval '6 hours')
            AND NOT EXISTS (
              SELECT 1 FROM writing_flow.scan_run r
              WHERE r.status='open'
                AND r.source_app_id=s.source_app_id
                AND r.source_table_id=s.source_table_id)
          ORDER BY s.next_dispatch_at NULLS FIRST,s.created_at,s.source_id
          FOR UPDATE OF s SKIP LOCKED
          LIMIT least($2,(SELECT available FROM capacity))`, [sourceTypes, limit]);
        if (!due.rowCount) return [];
        const ids = due.rows.map(row => row.source_id);
        const result = await client.query(`UPDATE writing_flow.source_record
          SET dispatch_status='sent',dispatch_count=dispatch_count+1,last_dispatched_at=now(),
              next_dispatch_at=now()+interval '6 hours',updated_at=now()
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
          p.trcc_required_override,repair.status AS trcc_repair_status,
          s.source_id,s.display_name,s.student_name,s.teacher_names,s.classroom_url,
          s.file_url,s.source_status,s.source_created_at
        FROM writing_flow.pair AS p
        LEFT JOIN writing_flow.source_record AS s ON s.source_id=p.source_id
        LEFT JOIN writing_flow.trcc_repair AS repair ON repair.pair_id=p.pair_id
        WHERE p.pair_id=$1`, [pairId]);
      if (!pair.rowCount) throw new ApiError(404, 'WRITING_PAIR_NOT_FOUND', 'Không tìm thấy bài này.');
      let source;
      try {
        const decoded = JSON.parse(open(pair.rows[0].source_ciphertext, key));
        const rescued = pair.rows[0].trcc_required_override === true;
        source = { taskType: decoded[0], topic: decoded[1], image: decoded[2],
          essay: decoded[3], trCcCheck: rescued ? true : decoded[4],
          trCcSource: rescued ? 'repair_override' : 'source',
          trCcRepairStatus: pair.rows[0].trcc_repair_status || null };
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
      let test = null;
      if (pair.rows[0].source_type === 'term_test') {
        const [summary, criteria, components, deliveries] = await Promise.all([
          pool.query(`SELECT test_group.display_name,test_group.test_config,test_group.topology,
              test_group.evidence_status,test_group.status AS group_status,
              test_pair.task_number,test_pair.status AS task_status,test_pair.component_count,
              test_pair.task_score,test_pair.graded_at,test_pair.delivered_at,
              test_final.task_1_score,test_final.task_2_score,test_final.writing_score,
              test_final.status AS final_status,test_final.ready_at
            FROM writing_flow.test_pair AS test_pair
            JOIN writing_flow.test_group AS test_group
              ON test_group.test_group_id=test_pair.test_group_id
            LEFT JOIN writing_flow.test_final AS test_final
              ON test_final.test_group_id=test_group.test_group_id
            WHERE test_pair.pair_id=$1`, [pairId]),
          pool.query(`SELECT criterion_code,name,band_score,feedback_ciphertext,completed_at
            FROM writing_flow.test_criterion_result WHERE pair_id=$1 ORDER BY criterion_code`, [pairId]),
          pool.query(`SELECT criterion_code,component_code,label,summary_ciphertext,
              feedback_ciphertext,completed_at
            FROM writing_flow.test_component_result WHERE pair_id=$1
            ORDER BY criterion_code,component_code`, [pairId]),
          pool.query(`SELECT destination,status,result_url,readback_ok,error_code,completed_at
            FROM writing_flow.test_delivery WHERE pair_id=$1 ORDER BY destination`, [pairId]),
        ]);
        const safeOpen = value => {
          try { return open(value, key); } catch { return null; }
        };
        test = summary.rows[0] ? { ...summary.rows[0],
          criteria: criteria.rows.map(row => ({ criterion_code: row.criterion_code,
            name: row.name, band_score: row.band_score,
            feedback: safeOpen(row.feedback_ciphertext), completed_at: row.completed_at,
            components: components.rows.filter(item => item.criterion_code === row.criterion_code)
              .map(item => ({ component_code: item.component_code,label: item.label,
                summary: safeOpen(item.summary_ciphertext),feedback: safeOpen(item.feedback_ciphertext),
                completed_at: item.completed_at })) })),
          deliveries: deliveries.rows } : null;
      }
      const { source_ciphertext: _ciphertext, ...safePair } = pair.rows[0];
      return { pair: safePair, source, stages: stageRows, test };
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
              result_ciphertext=NULL,selected_attempt_no=NULL,
              error_code=CASE WHEN stage_key=$4 THEN NULL ELSE 'UPSTREAM_RETRY_REQUESTED' END,
              n8n_execution_id=NULL,started_at=NULL,lease_expires_at=NULL,
              completed_at=NULL,updated_at=now()
          WHERE pair_id=$1 AND array_position($2::text[],stage_key) >= $3`,
        [pairId, STAGES, stageIndex + 1, stageKey]);
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
