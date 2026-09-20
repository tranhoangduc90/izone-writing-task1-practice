import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { createWritingFlowIntake } from './writing-flow-intake.js';
import { createWritingFlowOperations, STAGES } from './writing-flow-operations.js';
import { open } from './writing-flow-crypto.js';

// Nguồn vào: mapping lớp và phân công giảng viên đã có sẵn trong PostgreSQL.
// Việc chính: chuẩn hóa tên lớp thành mã lớp và gom các giảng viên đang hoạt động.
// Kết quả: dashboard lọc được theo giảng viên mà không ghi hoặc sửa dữ liệu Lark Base.
// Khi thiếu phân công: trả mảng rỗng để bài vẫn hiện theo lớp và trạng thái.
const teacherAssignmentsCte = `teacher_assignments AS (
  SELECT class_code,array_agg(DISTINCT teacher_name ORDER BY teacher_name) AS teacher_names
    FROM (
      SELECT CASE
        WHEN upper(course.erp_class_name_snapshot) ~ 'IC[[:space:].]*[0-9]{4,6}'
          THEN 'IC' || regexp_replace(substring(upper(course.erp_class_name_snapshot)
            from 'IC[[:space:].]*[0-9]{4,6}'),'[^0-9]','','g')
        WHEN upper(course.erp_class_name_snapshot) ~ 'CS[[:space:].]*[0-9]{6}'
          THEN 'CS.' || regexp_replace(substring(upper(course.erp_class_name_snapshot)
            from 'CS[[:space:].]*[0-9]{6}'),'[^0-9]','','g')
      END AS class_code,
      nullif(trim(account.display_name),'') AS teacher_name
      FROM mapping.classroom_course_mapping AS course
      JOIN mapping.reviewer_class_access AS access
        ON access.erp_course_class_id=course.erp_course_class_id
      JOIN mapping.reviewer_account AS account
        ON account.email=access.reviewer_email AND account.status='active'
    ) AS normalized
   WHERE class_code IS NOT NULL AND teacher_name IS NOT NULL
   GROUP BY class_code
)`;
const MAPPING_CLASS_SQL = `SELECT course.erp_course_class_id,
    course.erp_class_name_snapshot,course.classroom_course_id,
    course.classroom_course_name_snapshot,course.status AS mapping_status,
    course.updated_at,
    coalesce(array_agg(DISTINCT lower(access.class_status_snapshot))
      FILTER (WHERE access.class_status_snapshot IS NOT NULL),ARRAY[]::text[]) AS class_statuses,
    coalesce(array_agg(DISTINCT account.display_name ORDER BY account.display_name)
      FILTER (WHERE account.status='active' AND nullif(trim(account.display_name),'') IS NOT NULL),
      ARRAY[]::text[]) AS teacher_names
  FROM mapping.classroom_course_mapping AS course
  LEFT JOIN mapping.reviewer_class_access AS access
    ON access.erp_course_class_id=course.erp_course_class_id
  LEFT JOIN mapping.reviewer_account AS account ON account.email=access.reviewer_email
  GROUP BY course.erp_course_class_id,course.erp_class_name_snapshot,
    course.classroom_course_id,course.classroom_course_name_snapshot,
    course.status,course.updated_at
  ORDER BY course.erp_class_name_snapshot,course.erp_course_class_id`;

// Nhận vào: tên lớp từ nguồn mapping hoặc mã lớp trong bảng homework.
// Việc chính: nhận cả IC2269 và dạng CS.070626, rồi đưa về một cách viết ổn định.
// Trả ra: mã lớp để đối chiếu; chuỗi rỗng nếu tên không có mã lớp nhận biết được.
// Khi tên khác quy tắc: dashboard hiện “Không đọc được mã lớp” để người vận hành kiểm tra.
export function classCodeFromName(value) {
  const match = String(value || '').toUpperCase()
    .match(/\b(IC\s*\.?\s*\d{4,6}|CS\s*\.?\s*\d{6})\b/u);
  if (!match) return '';
  const compact = match[1].replace(/\s+/gu, '');
  if (compact.startsWith('IC')) return `IC${compact.replace(/\D/gu, '')}`;
  return `CS.${compact.replace(/\D/gu, '')}`;
}

export function documentIdFromSearch(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const fromUrl = text.match(/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{20,})/u)?.[1];
  if (fromUrl) return fromUrl;
  return /^[A-Za-z0-9_-]{20,}$/u.test(text) ? text : null;
}

export function mappingClassState(row) {
  const classCode = classCodeFromName(row.erp_class_name_snapshot);
  const statuses = [...new Set((row.class_statuses || []).filter(Boolean))];
  const classStatus = statuses.length === 1 && ['on_going', 'completed'].includes(statuses[0])
    ? statuses[0] : statuses.length > 1 ? 'conflict' : 'unknown';
  let operationalState = 'active';
  if (classCode === 'IC2288') operationalState = 'excluded';
  else if (!classCode) operationalState = 'missing_class_code';
  else if (!row.classroom_course_id) operationalState = 'missing_classroom_course';
  else if (row.mapping_status !== 'approved') operationalState = 'pending_review';
  else if (classStatus === 'completed') operationalState = 'completed';
  else if (classStatus !== 'on_going') operationalState = 'status_review';
  return { class_code: classCode || null, class_name: row.erp_class_name_snapshot,
    erp_course_class_id: row.erp_course_class_id,
    classroom_course_id: row.classroom_course_id,
    classroom_name: row.classroom_course_name_snapshot,
    mapping_status: row.mapping_status, class_status: classStatus,
    teacher_names: row.teacher_names || [], source_updated_at: row.updated_at,
    operational_state: operationalState, enabled: operationalState === 'active' };
}

// Nhận vào: toàn bộ lớp vừa đọc từ database mapping.
// Việc chính: phát hiện một mã lớp trỏ tới nhiều Classroom hoặc một Classroom trỏ tới nhiều mã lớp.
// Trả ra: các dòng xung đột được đưa vào danh sách cần kiểm tra và không được cấp lịch quét.
// Khi có xung đột: sổ lớp cũ của các mã liên quan sẽ bị tạm dừng trong cùng transaction đồng bộ.
export function markMappingConflicts(rows = []) {
  const byCode = new Map();
  const byCourse = new Map();
  for (const row of rows) {
    if (row.class_code) {
      const courses = byCode.get(row.class_code) || new Set();
      if (row.classroom_course_id) courses.add(String(row.classroom_course_id));
      byCode.set(row.class_code, courses);
    }
    if (row.classroom_course_id) {
      const codes = byCourse.get(String(row.classroom_course_id)) || new Set();
      if (row.class_code) codes.add(row.class_code);
      byCourse.set(String(row.classroom_course_id), codes);
    }
  }
  return rows.map(row => {
    const codeConflict = row.class_code && (byCode.get(row.class_code)?.size || 0) > 1;
    const courseConflict = row.classroom_course_id
      && (byCourse.get(String(row.classroom_course_id))?.size || 0) > 1;
    if (!codeConflict && !courseConflict) return row;
    return { ...row, operational_state: 'mapping_conflict', enabled: false };
  });
}

// Nhận vào: lớp đang vận hành từ mapping và mã lớp thấy trong lượt quét Writing gần nhất.
// Việc chính: ghép theo mã lớp, giữ cả lớp thiếu trong nguồn và lớp lạ có trong nguồn.
// Trả ra: các trạng thái ngắn để dashboard giải thích được việc đồng bộ lớp.
// Khi thiếu mã: giữ riêng dòng đó, không tự đoán hoặc coi là đã được quét.
export function mergeClassCoverage(expectedRows = [], seenRows = []) {
  const rows = new Map();
  const missingCode = [];
  for (const source of expectedRows) {
    const classCode = classCodeFromName(source.class_name);
    if (!classCode) {
      missingCode.push({ class_code: null, class_name: source.class_name || 'Chưa rõ tên lớp',
        status: 'class_code_missing', expected: true, seen: false,
        source_updated_at: source.source_updated_at || null, last_scanned_at: null });
      continue;
    }
    const current = rows.get(classCode) || { class_code: classCode, class_name: source.class_name,
      expected: true, seen: false, erp_source_found: true, classroom_source_found: true,
      source_updated_at: source.source_updated_at || null, last_scanned_at: null };
    current.expected = true;
    current.class_name ||= source.class_name;
    current.erp_source_found = current.erp_source_found && source.erp_source_found !== false;
    current.classroom_source_found = current.classroom_source_found
      && source.classroom_source_found !== false;
    current.mapping_status = source.mapping_status || null;
    current.class_status = source.class_status || null;
    current.operational_state = source.operational_state || null;
    current.teacher_names = source.teacher_names || [];
    rows.set(classCode, current);
  }
  for (const source of seenRows) {
    const classCode = classCodeFromName(source.class_code);
    if (!classCode) continue;
    const current = rows.get(classCode) || { class_code: classCode, class_name: classCode,
      expected: false, seen: false, erp_source_found: null, classroom_source_found: null,
      source_updated_at: null, last_scanned_at: null };
    current.seen = true;
    current.last_scanned_at = source.last_scanned_at || null;
    rows.set(classCode, current);
  }
  const priority = { missing_source: 0, mapping_issue: 1, mapping_conflict: 2,
    class_code_missing: 3, status_review: 4, pending_review: 5, unexpected_source: 6,
    excluded: 7, completed: 8, covered: 9 };
  const covered = [...rows.values()].map(row => ({ ...row,
    status: row.class_code === 'IC2288' ? 'excluded'
      : row.operational_state === 'completed' ? 'completed'
        : ['status_review', 'pending_review', 'missing_classroom_course', 'mapping_conflict']
            .includes(row.operational_state) ? row.operational_state
          : row.expected && (!row.erp_source_found || !row.classroom_source_found) ? 'mapping_issue'
        : row.expected && !row.seen ? 'missing_source'
          : !row.expected && row.seen ? 'unexpected_source' : 'covered' }));
  return [...covered, ...missingCode].sort((a, b) =>
    (priority[a.status] - priority[b.status])
      || String(a.class_code || a.class_name).localeCompare(String(b.class_code || b.class_name), 'vi'));
}

// Nhận vào: pool PostgreSQL và yêu cầu của quản trị viên đã xác thực.
// Việc chính: chỉ đọc trạng thái từng cặp hoặc ghi yêu cầu chạy lại vào hàng bàn giao bền.
// Trả ra: trạng thái, mã cặp và bước; không đọc bài làm hay kết quả đã mã hóa.
// Khi lỗi: transaction hoàn tác; màn hình nhận mã lỗi và giữ mục Cần kiểm tra.
export function createWritingFlowService({ pool, encryptionKey = null }) {
  const operations = createWritingFlowOperations({ pool, encryptionKey });
  async function teacherAssignmentsForDatabase() {
    return teacherAssignmentsCte;
  }
  async function mappingClasses(client = pool) {
    const result = await client.query(MAPPING_CLASS_SQL);
    return markMappingConflicts(result.rows.map(mappingClassState));
  }
  return {
    ...operations,
    intakePairs: createWritingFlowIntake({ pool, encryptionKey }),
    // Đọc thẳng database mapping rồi cập nhật sổ lớp Writing trong một transaction.
    // Không gọi Lark; lớp completed/không rõ vẫn được giữ để dashboard giải thích.
    async syncClassesFromMapping() {
      return withTransaction(pool, async client => {
        const classes = await mappingClasses(client);
        if (!classes.length) {
          throw new ApiError(503, 'MAPPING_CLASSES_EMPTY',
            'Database mapping chưa trả lớp nào; hệ thống giữ nguyên sổ lớp hiện tại.');
        }
        const registryClasses = classes.filter(row => row.class_code && row.classroom_course_id
          && row.operational_state !== 'mapping_conflict');
        const registered = [];
        for (const item of registryClasses) {
          const previousResult = await client.query(`SELECT class_code,classroom_course_id,
              enabled,mapping_status,class_status,eligibility_reason
            FROM writing_flow.class_registry WHERE class_code=$1 FOR UPDATE`, [item.class_code]);
          const previous = previousResult.rows[0] || null;
          const result = await client.query(`INSERT INTO writing_flow.class_registry
            (class_code,classroom_course_id,classroom_name,teacher_names,enabled,source_ref,
             scan_status,next_scan_at,erp_course_class_id,mapping_status,class_status,
             eligibility_reason,last_mapping_sync_at,updated_at)
            VALUES ($1,$2,$3,$4,$5,'mapping_database',
              CASE WHEN $5 THEN 'pending' ELSE 'paused' END,
              CASE WHEN $5 THEN now() ELSE now()+interval '100 years' END,
              $6,$7,$8,$9,now(),now())
            ON CONFLICT (class_code) DO UPDATE SET
              classroom_course_id=EXCLUDED.classroom_course_id,
              classroom_name=EXCLUDED.classroom_name,teacher_names=EXCLUDED.teacher_names,
              enabled=EXCLUDED.enabled,source_ref='mapping_database',
              erp_course_class_id=EXCLUDED.erp_course_class_id,
              mapping_status=EXCLUDED.mapping_status,class_status=EXCLUDED.class_status,
              eligibility_reason=EXCLUDED.eligibility_reason,last_mapping_sync_at=now(),
              scan_status=CASE
                WHEN NOT EXCLUDED.enabled THEN 'paused'
                WHEN NOT writing_flow.class_registry.enabled
                  OR writing_flow.class_registry.classroom_course_id IS DISTINCT FROM EXCLUDED.classroom_course_id
                  THEN 'pending' ELSE writing_flow.class_registry.scan_status END,
              scan_attempt_count=CASE WHEN NOT EXCLUDED.enabled THEN 0
                WHEN NOT writing_flow.class_registry.enabled THEN 0
                ELSE writing_flow.class_registry.scan_attempt_count END,
              next_scan_at=CASE
                WHEN NOT EXCLUDED.enabled THEN now()+interval '100 years'
                WHEN NOT writing_flow.class_registry.enabled
                  OR writing_flow.class_registry.classroom_course_id IS DISTINCT FROM EXCLUDED.classroom_course_id
                  THEN now() ELSE writing_flow.class_registry.next_scan_at END,
              updated_at=now()
            RETURNING class_code,enabled,mapping_status,class_status,scan_status`,
          [item.class_code, item.classroom_course_id, item.classroom_name,
            item.teacher_names, item.enabled, item.erp_course_class_id,
            item.mapping_status, item.class_status, item.operational_state]);
          const current = result.rows[0];
          registered.push(current);
          const before = previous ? {
            classroomCourseId: previous.classroom_course_id,
            enabled: previous.enabled,
            mappingStatus: previous.mapping_status,
            classStatus: previous.class_status,
            eligibilityReason: previous.eligibility_reason,
          } : {};
          const after = {
            classroomCourseId: item.classroom_course_id,
            enabled: item.enabled,
            mappingStatus: item.mapping_status,
            classStatus: item.class_status,
            eligibilityReason: item.operational_state,
          };
          if (!previous || JSON.stringify(before) !== JSON.stringify(after)) {
            await client.query(`INSERT INTO writing_flow.operator_event
              (class_code,event_type,actor_ref,request_id,reason,before_state,after_state)
              VALUES ($1,'class_mapping_changed','system:mapping-sync',gen_random_uuid(),
                'Đồng bộ trạng thái lớp từ database mapping',$2::jsonb,$3::jsonb)`,
            [item.class_code, JSON.stringify(before), JSON.stringify(after)]);
          }
        }
        const codes = registryClasses.map(row => row.class_code);
        if (!codes.length) {
          throw new ApiError(503, 'MAPPING_CLASSES_INVALID',
            'Chưa có lớp mapping nào đủ mã lớp và Classroom ID.');
        }
        const staleResult = await client.query(`SELECT class_code,classroom_course_id,
            enabled,mapping_status,class_status,eligibility_reason
          FROM writing_flow.class_registry WHERE NOT (class_code=ANY($1::text[])) FOR UPDATE`, [codes]);
        await client.query(`UPDATE writing_flow.class_registry
          SET enabled=false,scan_status='paused',scan_attempt_count=0,
              eligibility_reason='not_in_mapping',next_scan_at=now()+interval '100 years',
              last_mapping_sync_at=now(),updated_at=now()
          WHERE NOT (class_code=ANY($1::text[]))`, [codes]);
        for (const previous of staleResult.rows) {
          if (!previous.enabled && previous.eligibility_reason === 'not_in_mapping') continue;
          const before = {
            classroomCourseId: previous.classroom_course_id,
            enabled: previous.enabled,
            mappingStatus: previous.mapping_status,
            classStatus: previous.class_status,
            eligibilityReason: previous.eligibility_reason,
          };
          const after = { ...before, enabled: false, eligibilityReason: 'not_in_mapping' };
          await client.query(`INSERT INTO writing_flow.operator_event
            (class_code,event_type,actor_ref,request_id,reason,before_state,after_state)
            VALUES ($1,'class_mapping_changed','system:mapping-sync',gen_random_uuid(),
              'Lớp không còn trong database mapping',$2::jsonb,$3::jsonb)`,
          [previous.class_code, JSON.stringify(before), JSON.stringify(after)]);
        }
        return { received: classes.length, registered: registered.length,
          active: registered.filter(row => row.enabled).length,
          completed: classes.filter(row => row.operational_state === 'completed').length,
          needsReview: classes.filter(row => ['missing_class_code','missing_classroom_course',
            'pending_review','status_review','mapping_conflict'].includes(row.operational_state)).length,
          excluded: classes.filter(row => row.operational_state === 'excluded').length };
      });
    },
    // Nhận vào: định danh execution lỗi từ Error Trigger của n8n.
    // Việc chính: giữ một dòng cho một execution, kể cả lỗi trước khi tạo mã bài.
    // Trả ra: biên nhận và số lần cùng lỗi được gửi; không lưu stack hoặc nội dung bài.
    // Khi API tạm mất: n8n vẫn giữ execution lỗi để đối chiếu sau.
    async recordWorkflowFailure({ workflowId, workflowName, executionId, lastNode, errorKind }) {
      const result = await pool.query(`INSERT INTO writing_flow.workflow_failure
        (workflow_id,workflow_name,execution_id,last_node,error_kind)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (workflow_id,execution_id) DO UPDATE
          SET workflow_name=EXCLUDED.workflow_name,
              last_node=EXCLUDED.last_node,error_kind=EXCLUDED.error_kind,
              seen_count=writing_flow.workflow_failure.seen_count+1,last_seen_at=now()
        RETURNING failure_id,workflow_id,execution_id,seen_count`,
      [workflowId, workflowName, executionId, lastNode, errorKind]);
      return result.rows[0];
    },

    async listWorkflowFailures({ limit = 100, offset = 0 } = {}) {
      const result = await pool.query(`SELECT failure_id,workflow_id,workflow_name,execution_id,
          last_node,error_kind,seen_count,first_seen_at,last_seen_at
        FROM writing_flow.workflow_failure
        ORDER BY last_seen_at DESC,failure_id
        LIMIT $1 OFFSET $2`, [limit, offset]);
      return result.rows;
    },
    async recordSourceIssue({ appId, tableId, recordId, docId = null, linkIndex = null,
      essaySlot = null, classCode = null, reasonCode }) {
      // Chỉ lưu định danh kỹ thuật và mã lỗi; không lưu link gốc hoặc bài học viên.
      const issueKey = crypto.createHash('sha256')
        .update(JSON.stringify([appId, tableId, recordId, docId ?? '', linkIndex ?? 0,
          essaySlot ?? 0, reasonCode]))
        .digest('hex');
      const result = await pool.query(`
        INSERT INTO writing_flow.source_issue
          (issue_key,source_app_id,source_table_id,source_record_id,
           homework_file_id,source_link_index,
           essay_slot,class_code,reason_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        ON CONFLICT (issue_key) DO UPDATE
          SET status='open',resolved_at=NULL,
              occurrence_count=writing_flow.source_issue.occurrence_count+1,
              last_seen_at=now()
        RETURNING issue_key,status,reason_code,occurrence_count`,
      [issueKey, appId, tableId, recordId,
        docId, linkIndex, essaySlot, classCode, reasonCode]);
      return result.rows[0];
    },

    async listSourceIssues({ classCode = null, teacherName = null, search = null,
      reasonCode = null, limit = 100, offset = 0 } = {}) {
      const assignments = await teacherAssignmentsForDatabase();
      const searchDocId = documentIdFromSearch(search);
      const result = await pool.query(`
        WITH ${assignments}
        SELECT i.issue_key,i.source_app_id,i.source_table_id,i.source_record_id,
               i.homework_file_id,i.source_link_index,
               i.essay_slot,i.class_code,i.reason_code,i.occurrence_count,
               i.first_seen_at,i.last_seen_at,
               s.source_id,s.source_type,s.display_name,s.student_name,s.teacher_names,
               s.classroom_url,s.file_url,s.source_status
          FROM writing_flow.source_issue AS i
          LEFT JOIN writing_flow.source_record AS s
            ON s.source_app_id=i.source_app_id AND s.source_table_id=i.source_table_id
            AND s.source_record_id=i.source_record_id
            AND s.homework_file_id IS NOT DISTINCT FROM i.homework_file_id
            AND s.source_link_index IS NOT DISTINCT FROM i.source_link_index
          LEFT JOIN teacher_assignments AS teachers
            ON teachers.class_code=coalesce(i.class_code,s.class_code)
          LEFT JOIN writing_flow.class_registry AS registry
            ON registry.class_code=coalesce(i.class_code,s.class_code)
         WHERE i.status='open'
           AND registry.class_status IS DISTINCT FROM 'completed'
           AND ($1::text IS NULL OR coalesce(i.class_code,s.class_code)=$1)
           AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(s.teacher_names,ARRAY[]::text[]),
             teachers.teacher_names,ARRAY[]::text[])))
           AND ($3::text IS NULL OR i.homework_file_id=$4
             OR writing_flow.normalize_search(s.student_name)
               LIKE '%' || writing_flow.normalize_search($3) || '%')
           AND ($5::text IS NULL OR i.reason_code=$5)
         ORDER BY i.last_seen_at DESC,i.issue_key
         LIMIT $6 OFFSET $7`, [classCode, teacherName, search, searchDocId,
        reasonCode, limit, offset]);
      return result.rows;
    },
    async summary() {
      const assignments = await teacherAssignmentsForDatabase();
      const result = await pool.query(`
        WITH ${assignments}
        SELECT p.class_code,p.status,count(*)::integer AS pair_count,
               coalesce(t.teacher_names,ARRAY[]::text[]) AS teacher_names
          FROM writing_flow.pair AS p
          LEFT JOIN teacher_assignments AS t ON t.class_code=p.class_code
          LEFT JOIN writing_flow.class_registry AS registry ON registry.class_code=p.class_code
         WHERE registry.class_status IS DISTINCT FROM 'completed'
         GROUP BY p.class_code,p.status,t.teacher_names
         ORDER BY p.class_code,p.status`);
      return result.rows;
    },

    async dashboardCounts({ classCode = null, teacherName = null } = {}) {
      const assignments = await teacherAssignmentsForDatabase();
      const result = await pool.query(`WITH ${assignments}, current_pair AS (
          SELECT p.pair_id,p.class_code,p.status,p.skipped_at,
            coalesce(nullif(s.teacher_names,ARRAY[]::text[]),t.teacher_names,ARRAY[]::text[]) AS teacher_names,
            coalesce(active.stage_key,CASE WHEN p.status='delivered' THEN 'deliver' ELSE 'intake' END) AS stage_key,
            coalesce(active.stage_status,CASE WHEN p.status='delivered' THEN 'succeeded' ELSE 'pending' END) AS stage_status
          FROM writing_flow.pair AS p
          LEFT JOIN teacher_assignments AS t ON t.class_code=p.class_code
          LEFT JOIN writing_flow.source_record AS s ON s.source_id=p.source_id
          LEFT JOIN writing_flow.class_registry AS registry ON registry.class_code=p.class_code
          LEFT JOIN LATERAL (
            SELECT sr.stage_key,sr.status AS stage_status
            FROM writing_flow.stage_result AS sr
            WHERE sr.pair_id=p.pair_id
              AND sr.status IN ('pending','running','needs_review')
            ORDER BY array_position($3::text[],sr.stage_key) LIMIT 1
          ) AS active ON true
          WHERE p.status<>'superseded'
            AND registry.class_status IS DISTINCT FROM 'completed'
            AND ($1::text IS NULL OR p.class_code=$1)
            AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(s.teacher_names,ARRAY[]::text[]),t.teacher_names,ARRAY[]::text[])))
        )
        SELECT stage_key,stage_status,(skipped_at IS NOT NULL) AS skipped,count(*)::integer AS pair_count
        FROM current_pair GROUP BY stage_key,stage_status,(skipped_at IS NOT NULL)
        ORDER BY array_position($3::text[],stage_key),stage_status`,
      [classCode, teacherName, STAGES]);
      const support = await pool.query(`WITH ${assignments} SELECT
          (SELECT count(*)::integer FROM writing_flow.source_issue AS issue
            LEFT JOIN writing_flow.source_record AS source
              ON source.source_app_id=issue.source_app_id
             AND source.source_table_id=issue.source_table_id
             AND source.source_record_id=issue.source_record_id
             AND source.homework_file_id IS NOT DISTINCT FROM issue.homework_file_id
             AND source.source_link_index IS NOT DISTINCT FROM issue.source_link_index
            LEFT JOIN teacher_assignments AS teachers
              ON teachers.class_code=coalesce(issue.class_code,source.class_code)
            WHERE issue.status='open'
              AND ($1::text IS NULL OR coalesce(issue.class_code,source.class_code)=$1)
              AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(source.teacher_names,ARRAY[]::text[]),
                teachers.teacher_names,ARRAY[]::text[])))) AS source_issues,
          (SELECT count(*)::integer FROM writing_flow.manual_review AS review
            JOIN writing_flow.pair AS pair ON pair.pair_id=review.pair_id
            LEFT JOIN writing_flow.source_record AS source ON source.source_id=pair.source_id
            LEFT JOIN teacher_assignments AS teachers ON teachers.class_code=pair.class_code
            WHERE review.status<>'resolved'
              AND ($1::text IS NULL OR pair.class_code=$1)
              AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(source.teacher_names,ARRAY[]::text[]),
                teachers.teacher_names,ARRAY[]::text[])))) AS reviews,
          (SELECT count(*)::integer FROM writing_flow.workflow_failure
             WHERE last_seen_at>now()-interval '7 days') AS technical_errors`,
      [classCode, teacherName]);
      return { stages: result.rows, support: support.rows[0] };
    },

    async listClassCoverage() {
      const [mapping, seen] = await Promise.all([
        mappingClasses(),
        pool.query(`SELECT class_code,last_scan_at AS last_scanned_at
          FROM writing_flow.class_registry WHERE last_scan_at IS NOT NULL`),
      ]);
      const expected = mapping.map(item => ({ ...item, expected: item.enabled,
        erp_source_found: true, classroom_source_found: Boolean(item.classroom_course_id) }));
      return mergeClassCoverage(expected, seen.rows);
    },

    // Nhận vào: bộ lọc nhẹ từ dashboard quản trị.
    // Việc chính: đọc dấu vết thao tác người dùng và thay đổi mapping theo thứ tự mới nhất.
    // Trả ra: mã đối tượng, lớp, lý do và trạng thái trước/sau; không trả bài viết hay kết quả AI.
    // Khi lỗi: API trả mã truy vết chung để đối chiếu log server.
    async listOperatorEvents({ classCode = null, eventType = null,
      limit = 100, offset = 0 } = {}) {
      const result = await pool.query(`SELECT event.event_id,event.pair_id,event.source_id,
          coalesce(event.class_code,pair.class_code,source.class_code) AS class_code,
          event.event_type,event.actor_ref,event.reason,event.before_state,event.after_state,
          event.created_at
        FROM writing_flow.operator_event AS event
        LEFT JOIN writing_flow.pair AS pair ON pair.pair_id=event.pair_id
        LEFT JOIN writing_flow.source_record AS source ON source.source_id=event.source_id
        WHERE ($1::text IS NULL OR coalesce(event.class_code,pair.class_code,source.class_code)=$1)
          AND ($2::text IS NULL OR event.event_type=$2)
        ORDER BY event.created_at DESC,event.event_id DESC
        LIMIT $3 OFFSET $4`, [classCode, eventType, limit, offset]);
      return result.rows;
    },

    async listClasses({ view = 'active' } = {}) {
      const mapping = await mappingClasses();
      const registry = await pool.query(`SELECT class_code,scan_status,scan_attempt_count,
          last_scan_at,next_scan_at,last_error_code,updated_at
        FROM writing_flow.class_registry`);
      const byCode = new Map(registry.rows.map(row => [row.class_code, row]));
      const rows = mapping.map(item => ({ ...item, ...(byCode.get(item.class_code) || {}) }));
      if (view === 'active') return rows.filter(row => row.operational_state === 'active');
      if (view === 'completed') return rows.filter(row => row.operational_state === 'completed');
      if (view === 'review') return rows.filter(row => !['active', 'completed', 'excluded']
        .includes(row.operational_state));
      return rows;
    },

    async filterOptions() {
      const [classes, teachers] = await Promise.all([
        pool.query(`SELECT class_code,classroom_name,class_status,mapping_status,enabled
          FROM writing_flow.class_registry ORDER BY class_code`),
        pool.query(`SELECT DISTINCT unnest(teacher_names) AS teacher_name
          FROM writing_flow.source_record WHERE cardinality(teacher_names)>0
          ORDER BY teacher_name`),
      ]);
      return { classes: classes.rows, teachers: teachers.rows.map(row => row.teacher_name) };
    },

    async dailyStats({ classCode = null, teacherName = null, taskType = null,
      dateFrom = null, dateTo = null } = {}) {
      const assignments = await teacherAssignmentsForDatabase();
      const result = await pool.query(`WITH ${assignments}
        SELECT (deliver.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date AS day,
          count(DISTINCT p.pair_id)::integer AS completed_count
        FROM writing_flow.pair AS p
        JOIN writing_flow.stage_result AS deliver
          ON deliver.pair_id=p.pair_id AND deliver.stage_key='deliver'
         AND deliver.status='succeeded' AND deliver.completed_at IS NOT NULL
        LEFT JOIN writing_flow.source_record AS source ON source.source_id=p.source_id
        LEFT JOIN teacher_assignments AS teachers ON teachers.class_code=p.class_code
        WHERE p.status='delivered' AND p.skipped_at IS NULL
          AND ($1::text IS NULL OR p.class_code=$1)
          AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(source.teacher_names,ARRAY[]::text[]),
            teachers.teacher_names,ARRAY[]::text[])))
          AND ($3::text IS NULL OR p.task_type=$3)
          AND ($4::date IS NULL OR (deliver.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= $4)
          AND ($5::date IS NULL OR (deliver.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= $5)
        GROUP BY day ORDER BY day`, [classCode, teacherName, taskType, dateFrom, dateTo]);
      return result.rows;
    },

    async listPairs({ classCode = null, teacherName = null, stageKey = null,
      stageStatus = null, view = null, includeCompleted = false, taskType = null,
      search = null, dateFrom = null, dateTo = null, limit = 50, offset = 0,
      cursorAt = null, cursorId = null } = {}) {
      const assignments = await teacherAssignmentsForDatabase();
      const searchDocId = documentIdFromSearch(search);
      const result = await pool.query(`
        WITH ${assignments}
        SELECT p.pair_id, p.class_code, p.source_app_id, p.source_table_id,
               p.source_record_id, p.homework_file_id,
               p.source_link_index, p.essay_slot, p.task_type, p.status,
               p.source_type,p.created_at,p.updated_at,
               coalesce(p.finished_at,deliver.completed_at) AS finished_at,p.skipped_at,
               p.skipped_by,p.skip_reason,
               coalesce(s.display_name,'') AS display_name,
               coalesce(s.student_name,'') AS student_name,
               coalesce(nullif(s.teacher_names,ARRAY[]::text[]),t.teacher_names,ARRAY[]::text[]) AS teacher_names,
               s.classroom_url,s.file_url,s.source_status,s.source_created_at,
               coalesce(current_stage.stage_key,
                 CASE WHEN p.status='delivered' THEN 'deliver' ELSE 'intake' END) AS stage_key,
               coalesce(current_stage.stage_status,
                 CASE WHEN p.status='delivered' THEN 'succeeded' ELSE 'pending' END) AS stage_status,
               coalesce(current_stage.attempt_count,0) AS attempt_count,
               current_stage.error_code AS last_error_code,p.source_ciphertext,
               EXISTS (SELECT 1 FROM writing_flow.stage_result AS graded
                 WHERE graded.pair_id=p.pair_id AND graded.stage_key IN ('main','render')
                   AND graded.status='succeeded') AS grading_text_available
          FROM writing_flow.pair AS p
          LEFT JOIN teacher_assignments AS t ON t.class_code=p.class_code
          LEFT JOIN writing_flow.source_record AS s ON s.source_id=p.source_id
          LEFT JOIN writing_flow.class_registry AS registry ON registry.class_code=p.class_code
          LEFT JOIN writing_flow.stage_result AS deliver
            ON deliver.pair_id=p.pair_id AND deliver.stage_key='deliver'
          LEFT JOIN LATERAL (
            SELECT s.stage_key, s.status AS stage_status, s.attempt_count,s.error_code
             FROM writing_flow.stage_result AS s
             WHERE s.pair_id = p.pair_id
               AND s.status IN ('pending','running','needs_review')
             ORDER BY array_position($3::text[],s.stage_key)
             LIMIT 1
          ) AS current_stage ON true
         WHERE ($1::text IS NULL OR p.class_code = $1)
           AND ($2::text IS NULL OR $2 = ANY(coalesce(nullif(s.teacher_names,ARRAY[]::text[]),t.teacher_names,ARRAY[]::text[])))
           AND p.status<>'superseded'
           AND ($7::boolean OR registry.class_status IS DISTINCT FROM 'completed')
           AND ($8::text IS NULL OR p.task_type=$8)
           AND ($9::text IS NULL OR p.homework_file_id=$10
             OR writing_flow.normalize_search(s.student_name)
               LIKE '%' || writing_flow.normalize_search($9) || '%')
           AND ($11::date IS NULL OR coalesce(s.source_created_at,p.created_at)
             >= ($11::date AT TIME ZONE 'Asia/Ho_Chi_Minh'))
           AND ($12::date IS NULL OR coalesce(s.source_created_at,p.created_at)
             < (($12::date+1) AT TIME ZONE 'Asia/Ho_Chi_Minh'))
           AND ($4::text IS NULL OR coalesce(current_stage.stage_key,
                 CASE WHEN p.status='delivered' THEN 'deliver' ELSE 'intake' END)=$4)
           AND ($5::text IS NULL OR coalesce(current_stage.stage_status,
                 CASE WHEN p.status='delivered' THEN 'succeeded' ELSE 'pending' END)=$5)
           AND (($6::text='skipped' AND p.skipped_at IS NOT NULL)
             OR ($6::text='delivered' AND p.status='delivered' AND p.skipped_at IS NULL)
             OR ($6::text='unfinished' AND p.status<>'delivered' AND p.skipped_at IS NULL)
             OR ($6::text IS NULL AND p.skipped_at IS NULL))
           AND ($13::timestamptz IS NULL OR (p.updated_at,p.pair_id)<($13::timestamptz,$14::uuid))
         ORDER BY p.updated_at DESC, p.pair_id DESC
         LIMIT $15 OFFSET $16`, [classCode, teacherName, STAGES, stageKey, stageStatus, view,
        includeCompleted, taskType, search, searchDocId, dateFrom, dateTo,
        cursorAt, cursorId, limit, offset]);
      return result.rows.map(row => {
        let topic = null; let imageUrl = null; let trCcCheck = null;
        if (encryptionKey && row.source_ciphertext) {
          try {
            const decoded = JSON.parse(open(row.source_ciphertext, encryptionKey));
            topic = decoded[1] || null; imageUrl = decoded[2] || null;
            trCcCheck = typeof decoded[4] === 'boolean' ? decoded[4] : null;
          } catch { /* Chi tiết vẫn báo lỗi giải mã khi người dùng mở dòng. */ }
        }
        const { source_ciphertext: _hidden, ...safe } = row;
        return { ...safe, topic, image_url: imageUrl, tr_cc_check: trCcCheck };
      });
    },

    // Nhận vào: mã của đúng một cặp đề–bài do quản trị viên chọn trên trang.
    // Việc chính: ghép các mốc giai đoạn, lần thử, AI, bàn giao và kiểm tra thành lịch sử theo giờ.
    // Trả ra: mã kỹ thuật, trạng thái và lỗi; không truy vấn bài viết, prompt hoặc kết quả đã mã hóa.
    // Khi không thấy bài: trả 404 để trang không nhầm lịch sử của một bài khác.
    async pairHistory({ pairId }) {
      const found = await pool.query(`SELECT p.pair_id,p.class_code,p.task_type,p.essay_slot,p.status,
          p.source_type,p.skipped_at,p.skipped_by,p.skip_reason,p.finished_at,
          s.display_name,s.student_name,s.teacher_names,s.classroom_url,s.file_url,s.source_status
        FROM writing_flow.pair AS p LEFT JOIN writing_flow.source_record AS s ON s.source_id=p.source_id
        WHERE p.pair_id=$1`, [pairId]);
      if (!found.rowCount) throw new ApiError(404, 'WRITING_PAIR_NOT_FOUND', 'Không tìm thấy bài này.');
      const [stages, attempts, aiCalls, handoffs, reviews, operatorEvents] = await Promise.all([
        pool.query(`SELECT stage_key,status,cycle_no,attempt_count,error_code,
            n8n_execution_id,started_at,completed_at,updated_at
          FROM writing_flow.stage_result WHERE pair_id=$1`, [pairId]),
        pool.query(`SELECT stage_key,cycle_no,attempt_no,status,error_code,
            n8n_execution_id,attempt_id,started_at,finished_at
          FROM writing_flow.stage_attempt WHERE pair_id=$1
          ORDER BY started_at,attempt_id LIMIT 100`, [pairId]),
        pool.query(`SELECT stage_key,batch_index,status,provider,route,error_code,
            call_id,gateway_operation_id,created_at,finished_at
          FROM writing_flow.ai_call WHERE pair_id=$1
          ORDER BY created_at,call_id LIMIT 500`, [pairId]),
        pool.query(`SELECT from_stage,to_stage,status,send_count,error_code,
            handoff_id,created_at,last_sent_at,acknowledged_at
          FROM writing_flow.handoff WHERE pair_id=$1
          ORDER BY created_at,handoff_id LIMIT 100`, [pairId]),
        pool.query(`SELECT stage_key,cycle_no,status,error_code,review_id,
            opened_at,retry_requested_at,retry_accepted_at,resolved_at
          FROM writing_flow.manual_review WHERE pair_id=$1
          ORDER BY opened_at,review_id LIMIT 100`, [pairId]),
        pool.query(`SELECT event_type,actor_ref,reason,before_state,after_state,created_at,event_id
          FROM writing_flow.operator_event WHERE pair_id=$1
          ORDER BY created_at,event_id LIMIT 200`, [pairId]),
      ]);
      const events = [
        ...stages.rows.map(row => ({ kind: 'stage', at: row.updated_at, ...row })),
        ...attempts.rows.map(row => ({ kind: 'attempt', at: row.finished_at || row.started_at, ...row })),
        ...aiCalls.rows.map(row => ({ kind: 'ai_call', at: row.finished_at || row.created_at, ...row })),
        ...handoffs.rows.map(row => ({ kind: 'handoff', at: row.acknowledged_at || row.last_sent_at || row.created_at, ...row })),
        ...reviews.rows.map(row => ({ kind: 'review', at: row.resolved_at || row.retry_accepted_at || row.retry_requested_at || row.opened_at, ...row })),
        ...operatorEvents.rows.map(row => ({ kind: 'operator', at: row.created_at, ...row })),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      return { pair: found.rows[0], events };
    },

    async listReviews({ classCode = null, teacherName = null, stageKey = null,
      search = null, limit = 100, offset = 0 } = {}) {
      const assignments = await teacherAssignmentsForDatabase();
      const searchDocId = documentIdFromSearch(search);
      const result = await pool.query(`
        WITH ${assignments}
        SELECT r.review_id, r.pair_id, r.stage_key, r.cycle_no, r.status,
               r.error_code, r.opened_at, r.checked_at, r.retry_requested_at,
               s.attempt_count, p.class_code, p.source_app_id,
               p.source_table_id, p.source_record_id,
               p.homework_file_id, p.source_link_index, p.essay_slot,
               p.task_type,
               coalesce(nullif(source.teacher_names,ARRAY[]::text[]),
                 t.teacher_names,ARRAY[]::text[]) AS teacher_names,
               source.student_name,source.classroom_url,source.file_url,source.source_status
          FROM writing_flow.manual_review AS r
          JOIN writing_flow.pair AS p ON p.pair_id = r.pair_id
          LEFT JOIN teacher_assignments AS t ON t.class_code=p.class_code
          LEFT JOIN writing_flow.source_record AS source ON source.source_id=p.source_id
          LEFT JOIN writing_flow.class_registry AS registry ON registry.class_code=p.class_code
          JOIN writing_flow.stage_result AS s
            ON s.pair_id = r.pair_id AND s.stage_key = r.stage_key
         WHERE r.status <> 'resolved'
           AND registry.class_status IS DISTINCT FROM 'completed'
           AND ($1::text IS NULL OR p.class_code=$1)
           AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(source.teacher_names,ARRAY[]::text[]),
             t.teacher_names,ARRAY[]::text[])))
           AND ($3::text IS NULL OR r.stage_key=$3)
           AND ($4::text IS NULL OR p.homework_file_id=$5
             OR writing_flow.normalize_search(source.student_name)
               LIKE '%' || writing_flow.normalize_search($4) || '%')
         ORDER BY r.opened_at, r.review_id
         LIMIT $6 OFFSET $7`, [classCode, teacherName, stageKey, search, searchDocId,
        limit, offset]);
      return result.rows;
    },

    async requestRetry({ reviewId, requestId, actorRef }) {
      const normalizedRequestId = requestId.toLowerCase();
      return withTransaction(pool, async client => {
        const found = await client.query(`
          SELECT r.review_id, r.pair_id, r.stage_key, r.cycle_no,
                 r.status, r.retry_command_key,
                 s.status AS stage_status, s.attempt_count,
                 s.cycle_no AS stage_cycle_no,
                 p.status AS pair_status
            FROM writing_flow.manual_review AS r
            JOIN writing_flow.stage_result AS s
              ON s.pair_id = r.pair_id AND s.stage_key = r.stage_key
            JOIN writing_flow.pair AS p ON p.pair_id = r.pair_id
           WHERE r.review_id = $1
           FOR UPDATE OF r, s, p`, [reviewId]);
        if (found.rowCount !== 1) throw new ApiError(404, 'REVIEW_NOT_FOUND', 'Không tìm thấy bài cần kiểm tra.');
        const row = found.rows[0];
        if (row.retry_command_key === normalizedRequestId && row.status !== 'open') {
          return { reviewId, status: row.status, retryCommandKey: normalizedRequestId };
        }
        if (row.status !== 'open') {
          throw new ApiError(409, 'RETRY_ALREADY_REQUESTED', 'Bài đã có yêu cầu chạy lại.');
        }
        if (row.pair_status !== 'needs_review' || row.stage_status !== 'needs_review'
          || row.stage_cycle_no !== row.cycle_no || Number(row.attempt_count) !== 3) {
          throw new ApiError(409, 'REVIEW_STATE_CHANGED', 'Trạng thái bài đã thay đổi; hãy tải lại danh sách.');
        }
        const commandHash = crypto.createHash('sha256').update(normalizedRequestId).digest('hex');
        await client.query(`
          UPDATE writing_flow.manual_review
             SET status = 'retry_requested', checked_at = now(), checked_by = $2,
                 retry_command_key = $3, retry_requested_at = now()
           WHERE review_id = $1`, [reviewId, actorRef, normalizedRequestId]);
        await client.query(`
          INSERT INTO writing_flow.handoff
            (pair_id, from_stage, to_stage, source_result_sha256, status, next_send_at)
          VALUES ($1, 'review', $2, $3, 'pending', now())`,
        [row.pair_id, row.stage_key, commandHash]);
        return { reviewId, status: 'retry_requested', retryCommandKey: normalizedRequestId };
      });
    },
  };
}
