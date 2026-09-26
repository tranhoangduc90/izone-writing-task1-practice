import crypto from 'node:crypto';
import { withTransaction } from './db.js';
import { ApiError } from './service.js';
import { createWritingFlowIntake } from './writing-flow-intake.js';
import { createWritingFlowOperations, STAGES } from './writing-flow-operations.js';
import { keyFromHex, open } from './writing-flow-crypto.js';
import { normalizeWritingSearch, writingSearchPreview, writingSearchTokens } from './writing-flow-search.js';

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
const MAPPING_CLASS_SQL = `WITH mapped_courses AS (
  SELECT course.erp_course_class_id,
    course.erp_class_name_snapshot,course.classroom_course_id,
    course.classroom_course_name_snapshot,course.classroom_section_snapshot,
    course.status AS mapping_status,
    course.updated_at,
    coalesce(array_agg(DISTINCT lower(access.class_status_snapshot))
      FILTER (WHERE access.class_status_snapshot IS NOT NULL),ARRAY[]::text[]) AS class_statuses,
    coalesce(array_agg(DISTINCT account.display_name ORDER BY account.display_name)
      FILTER (WHERE account.status='active' AND nullif(trim(account.display_name),'') IS NOT NULL),
      ARRAY[]::text[]) AS teacher_names,
    'mapping:' || course.erp_course_class_id::text AS source_ref
  FROM mapping.classroom_course_mapping AS course
  LEFT JOIN mapping.reviewer_class_access AS access
    ON access.erp_course_class_id=course.erp_course_class_id
  LEFT JOIN mapping.reviewer_account AS account ON account.email=access.reviewer_email
  GROUP BY course.erp_course_class_id,course.erp_class_name_snapshot,
    course.classroom_course_id,course.classroom_course_name_snapshot,
    course.classroom_section_snapshot,
    course.status,course.updated_at
), direct_courses AS (
  SELECT NULL::bigint AS erp_course_class_id,
    direct.class_name_snapshot AS erp_class_name_snapshot,
    direct.classroom_course_id,
    direct.classroom_course_name_snapshot,
    direct.classroom_section_snapshot,
    direct.status AS mapping_status,
    direct.updated_at,
    ARRAY[direct.class_status]::text[] AS class_statuses,
    ARRAY[]::text[] AS teacher_names,
    'classroom_direct:' || direct.class_code AS source_ref
  FROM mapping.classroom_direct_class AS direct
)
SELECT * FROM mapped_courses
UNION ALL
SELECT * FROM direct_courses
ORDER BY erp_class_name_snapshot,erp_course_class_id NULLS LAST`;

const ALLOWED_IC_CLASS_INFO = new Set([
  'Chuyên sâu (6.0 - 7.0)',
  'Chiến lược (5.0 - 6.0)',
  'Lớp 1-1',
]);
const TERM_TEST_CLASS_NAMES = new Map([
  ['term test 2 khóa chuyên sâu', 'Term test 2 khóa Chuyên sâu'],
  ['term test 2 khóa chiến lược', 'Term test 2 khóa Chiến lược'],
  ['term test 1 khóa chuyên sâu', 'Term test 1 khóa Chuyên sâu'],
  ['term test 1 khóa chiến lược', 'Term test 1 khóa Chiến lược'],
]);
const HIDDEN_CLASS_REASONS = ['excluded', 'excluded_ic_before_2065',
  'excluded_ic_program', 'excluded_teacher'];
const visibleRegistrySql = alias => `(${alias}.class_code IS NULL
  OR coalesce(${alias}.eligibility_reason,'') <> ALL($VISIBLE_CLASS_REASONS$::text[]))`
  .replace('$VISIBLE_CLASS_REASONS$', `ARRAY[${HIDDEN_CLASS_REASONS.map(value => `'${value}'`).join(',')}]`);
// Bài giả vẫn giữ trong database để xem nhật ký kiểm thử, nhưng không được tính là bài học viên.
const visibleOperationalSourceSql = alias => `${alias}.source_app_id IS DISTINCT FROM 'codex_fixture'`;

// Nhận vào: tối đa ba quy tắc sort từ dashboard, ví dụ finished:desc,student:asc.
// Việc chính: chỉ đổi các khóa đã duyệt thành biểu thức SQL cố định; không đưa text người dùng vào SQL.
// Kết quả: bảng được sắp ổn định và luôn dùng pair_id làm khóa cuối để tránh thứ tự mơ hồ.
// Khi sai: API trả lỗi rõ, không âm thầm dùng một câu ORDER BY ngoài allowlist.
const pairSortExpressions = {
  updated: 'p.updated_at',
  finished: 'coalesce(p.finished_at,deliver.completed_at)',
  created: 'coalesce(s.source_created_at,p.created_at)',
  student: "writing_flow.normalize_search(coalesce(nullif(s.student_name,''),s.display_name,''))",
  class: 'p.class_code',
  teacher: "writing_flow.normalize_search(array_to_string(coalesce(nullif(s.teacher_names,ARRAY[]::text[]),t.teacher_names,ARRAY[]::text[]),','))",
  status: 'p.status',
  attempts: 'coalesce(current_stage.attempt_count,0)',
};

export function normalizeWritingSort(value) {
  if (!value) return [];
  const rules = String(value).split(',').map(item => item.trim()).filter(Boolean);
  if (!rules.length || rules.length > 3) {
    throw new ApiError(400, 'WRITING_SORT_INVALID', 'Chỉ được sắp xếp tối đa ba điều kiện.');
  }
  const seen = new Set();
  return rules.map(rule => {
    const [key, direction, extra] = rule.split(':');
    if (extra || !pairSortExpressions[key] || !['asc', 'desc'].includes(direction)
      || seen.has(key)) {
      throw new ApiError(400, 'WRITING_SORT_INVALID', 'Điều kiện sắp xếp không hợp lệ.');
    }
    seen.add(key);
    return { key, direction };
  });
}

function pairOrderSql(rules) {
  if (!rules.length) return 'p.updated_at DESC, p.pair_id DESC';
  const clauses = rules.map(({ key, direction }) =>
    `${pairSortExpressions[key]} ${direction.toUpperCase()} NULLS LAST`);
  return [...clauses, 'p.pair_id DESC'].join(', ');
}

// Nhận vào: tên lớp từ nguồn mapping hoặc mã lớp trong bảng homework.
// Việc chính: nhận cả IC2269 và dạng CS.070626, rồi đưa về một cách viết ổn định.
// Trả ra: mã lớp để đối chiếu; chuỗi rỗng nếu tên không có mã lớp nhận biết được.
// Khi tên khác quy tắc: dashboard hiện “Không đọc được mã lớp” để người vận hành kiểm tra.
export function classCodeFromName(value) {
  const normalizedName = String(value || '').replace(/\s+/gu, ' ').trim();
  const termTestCode = TERM_TEST_CLASS_NAMES.get(normalizedName.toLocaleLowerCase('vi'));
  if (termTestCode) return termTestCode;
  const match = normalizedName.toUpperCase()
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
  const classInfo = String(row.classroom_section_snapshot || '').replace(/\s+/gu, ' ').trim();
  const statuses = [...new Set((row.class_statuses || []).filter(Boolean))];
  const classStatus = statuses.length === 1 && ['on_going', 'completed'].includes(statuses[0])
    ? statuses[0] : statuses.length > 1 ? 'conflict' : 'unknown';
  let operationalState = 'active';
  let eligibilityReason = 'active';
  const icNumber = /^IC(\d+)$/u.test(classCode) ? Number(classCode.slice(2)) : null;
  const teacherExcluded = (Array.isArray(row.teacher_names) ? row.teacher_names : [])
    .some(name => String(name)
      .normalize('NFKD').replace(/\p{M}/gu, '').replace(/đ/giu, 'd')
      .replace(/\s+/gu, ' ').trim().toLowerCase() === 'hoang dieu phap');
  if (!classCode) operationalState = eligibilityReason = 'missing_class_code';
  else if (classCode === 'IC2288') {
    operationalState = 'excluded'; eligibilityReason = 'excluded';
  } else if (teacherExcluded) {
    operationalState = 'excluded'; eligibilityReason = 'excluded_teacher';
  } else if (icNumber !== null && icNumber < 2065) {
    operationalState = 'excluded'; eligibilityReason = 'excluded_ic_before_2065';
  } else if (icNumber !== null && !ALLOWED_IC_CLASS_INFO.has(classInfo)) {
    operationalState = 'excluded'; eligibilityReason = 'excluded_ic_program';
  }
  else if (!row.classroom_course_id) operationalState = 'missing_classroom_course';
  else if (row.mapping_status !== 'approved') operationalState = 'pending_review';
  else if (classStatus === 'completed') operationalState = 'completed';
  // Hai lớp CS có trong danh sách đang học của Lark nhưng nguồn mapping chưa ghi trạng thái.
  // Vẫn cho quét để không bỏ sót bài; dashboard giữ class_status=unknown để người vận hành thấy rõ.
  else if (classStatus !== 'on_going' && !/^CS\./u.test(classCode)) operationalState = 'status_review';
  if (operationalState !== 'excluded') eligibilityReason = operationalState;
  return { class_code: classCode || null, class_name: row.erp_class_name_snapshot,
    erp_course_class_id: row.erp_course_class_id,
    classroom_course_id: row.classroom_course_id,
    classroom_name: row.classroom_course_name_snapshot,
    class_info: classInfo || null,
    mapping_status: row.mapping_status, class_status: classStatus,
    source_ref: row.source_ref || (row.erp_course_class_id == null
      ? `classroom_direct:${classCode}` : `mapping:${row.erp_course_class_id}`),
    teacher_names: row.teacher_names || [], source_updated_at: row.updated_at,
    operational_state: operationalState, eligibility_reason: eligibilityReason,
    enabled: operationalState === 'active' };
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
    status: row.class_code === 'IC2288' || row.eligibility_reason === 'excluded_teacher'
      ? 'excluded'
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
  const key = Buffer.isBuffer(encryptionKey) ? encryptionKey : keyFromHex(encryptionKey);
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
              cohort,enabled,mapping_status,class_status,eligibility_reason
            FROM writing_flow.class_registry WHERE class_code=$1 FOR UPDATE`, [item.class_code]);
          const previous = previousResult.rows[0] || null;
          const result = await client.query(`INSERT INTO writing_flow.class_registry
            (class_code,classroom_course_id,classroom_name,cohort,teacher_names,enabled,source_ref,
             scan_status,next_scan_at,erp_course_class_id,mapping_status,class_status,
             eligibility_reason,last_mapping_sync_at,updated_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,
              CASE WHEN $6 THEN 'pending' ELSE 'paused' END,
              CASE WHEN $6 THEN now() ELSE now()+interval '100 years' END,
              $8,$9,$10,$11,now(),now())
            ON CONFLICT (class_code) DO UPDATE SET
              classroom_course_id=EXCLUDED.classroom_course_id,
              classroom_name=EXCLUDED.classroom_name,cohort=EXCLUDED.cohort,
              teacher_names=EXCLUDED.teacher_names,
              enabled=EXCLUDED.enabled,source_ref=EXCLUDED.source_ref,
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
            item.class_info, item.teacher_names, item.enabled, item.source_ref,
            item.erp_course_class_id, item.mapping_status, item.class_status,
            item.eligibility_reason]);
          const current = result.rows[0];
          registered.push(current);
          const before = previous ? {
            classroomCourseId: previous.classroom_course_id,
            classInfo: previous.cohort,
            enabled: previous.enabled,
            mappingStatus: previous.mapping_status,
            classStatus: previous.class_status,
            eligibilityReason: previous.eligibility_reason,
          } : {};
          const after = {
            classroomCourseId: item.classroom_course_id,
            classInfo: item.class_info,
            enabled: item.enabled,
            mappingStatus: item.mapping_status,
            classStatus: item.class_status,
            eligibilityReason: item.eligibility_reason,
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
          SET status=CASE WHEN writing_flow.source_issue.status='skipped'
                THEN 'skipped' ELSE 'open' END,
              resolved_at=CASE WHEN writing_flow.source_issue.status='skipped'
                THEN writing_flow.source_issue.resolved_at ELSE NULL END,
              occurrence_count=writing_flow.source_issue.occurrence_count+1,
              last_seen_at=now()
        RETURNING issue_key,status,reason_code,occurrence_count`,
      [issueKey, appId, tableId, recordId,
        docId, linkIndex, essaySlot, classCode, reasonCode]);
      return result.rows[0];
    },

    async listSourceIssues({ classCode = null, teacherName = null, search = null,
      reasonCode = null, status = 'open', limit = 100, offset = 0 } = {}) {
      const assignments = await teacherAssignmentsForDatabase();
      const searchDocId = documentIdFromSearch(search);
      const result = await pool.query(`
        WITH ${assignments}
        SELECT i.issue_key,i.source_app_id,i.source_table_id,i.source_record_id,
               i.homework_file_id,i.source_link_index,
               i.essay_slot,i.class_code,i.reason_code,i.occurrence_count,
               i.first_seen_at,i.last_seen_at,i.status,
               i.skipped_at,i.skipped_by,i.skip_reason,
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
         WHERE i.status=$6
           AND ${visibleOperationalSourceSql('i')}
           AND registry.class_status IS DISTINCT FROM 'completed'
           AND ${visibleRegistrySql('registry')}
           AND ($1::text IS NULL OR coalesce(i.class_code,s.class_code)=$1)
           AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(s.teacher_names,ARRAY[]::text[]),
             teachers.teacher_names,ARRAY[]::text[])))
           AND ($3::text IS NULL OR i.homework_file_id=$4
             OR writing_flow.normalize_search(s.student_name)
               LIKE '%' || writing_flow.normalize_search($3) || '%')
           AND ($5::text IS NULL OR i.reason_code=$5)
         ORDER BY i.last_seen_at DESC,i.issue_key
         LIMIT $7 OFFSET $8`, [classCode, teacherName, search, searchDocId,
        reasonCode, status, limit, offset]);
      return result.rows;
    },

    // Nhận vào: đúng một lỗi nguồn người vận hành chọn trên dashboard.
    // Việc chính: đưa lỗi vào thùng rác mềm và ghi ai đã thao tác; không sửa Lark Base.
    // Kết quả: lỗi biến khỏi danh sách cần xử lý nhưng vẫn khôi phục được ở tab Đã bỏ qua.
    // Khi lỗi: transaction hoàn tác, lượt quét và bài chấm hiện tại không bị thay đổi.
    async skipSourceIssue({ issueKey, requestId, actorRef, reason }) {
      return withTransaction(pool, async client => {
        const duplicate = await client.query(`SELECT event_type FROM writing_flow.operator_event
          WHERE request_id=$1`, [requestId]);
        if (duplicate.rowCount) return { issueKey, status: 'skipped', requestId };
        const found = await client.query(`SELECT i.issue_key,i.status,i.class_code,s.source_id
          FROM writing_flow.source_issue AS i
          LEFT JOIN writing_flow.source_record AS s
            ON s.source_app_id=i.source_app_id AND s.source_table_id=i.source_table_id
           AND s.source_record_id=i.source_record_id
           AND s.homework_file_id IS NOT DISTINCT FROM i.homework_file_id
           AND s.source_link_index IS NOT DISTINCT FROM i.source_link_index
          WHERE i.issue_key=$1 FOR UPDATE OF i`, [issueKey]);
        if (!found.rowCount) throw new ApiError(404, 'SOURCE_ISSUE_NOT_FOUND', 'Không tìm thấy lỗi nguồn này.');
        if (found.rows[0].status === 'skipped') {
          throw new ApiError(409, 'SOURCE_ISSUE_ALREADY_SKIPPED', 'Lỗi nguồn đã được bỏ qua.');
        }
        if (found.rows[0].status !== 'open') {
          throw new ApiError(409, 'SOURCE_ISSUE_NOT_OPEN', 'Lỗi nguồn không còn ở danh sách cần xử lý.');
        }
        await client.query(`UPDATE writing_flow.source_issue
          SET status='skipped',skipped_at=now(),skipped_by=$2,skip_reason=$3
          WHERE issue_key=$1`, [issueKey, actorRef, reason]);
        await client.query(`INSERT INTO writing_flow.operator_event
          (source_id,class_code,source_issue_key,event_type,actor_ref,request_id,reason,
           before_state,after_state)
          VALUES ($1,$2,$3,'source_issue_skipped',$4,$5,$6,
            '{"status":"open"}'::jsonb,'{"status":"skipped"}'::jsonb)`,
        [found.rows[0].source_id, found.rows[0].class_code, issueKey,
          actorRef, requestId, reason]);
        return { issueKey, status: 'skipped', requestId };
      });
    },

    async restoreSourceIssue({ issueKey, requestId, actorRef, reason }) {
      return withTransaction(pool, async client => {
        const duplicate = await client.query(`SELECT event_type FROM writing_flow.operator_event
          WHERE request_id=$1`, [requestId]);
        if (duplicate.rowCount) return { issueKey, status: 'open', requestId };
        const found = await client.query(`SELECT i.issue_key,i.status,i.class_code,s.source_id
          FROM writing_flow.source_issue AS i
          LEFT JOIN writing_flow.source_record AS s
            ON s.source_app_id=i.source_app_id AND s.source_table_id=i.source_table_id
           AND s.source_record_id=i.source_record_id
           AND s.homework_file_id IS NOT DISTINCT FROM i.homework_file_id
           AND s.source_link_index IS NOT DISTINCT FROM i.source_link_index
          WHERE i.issue_key=$1 FOR UPDATE OF i`, [issueKey]);
        if (!found.rowCount) throw new ApiError(404, 'SOURCE_ISSUE_NOT_FOUND', 'Không tìm thấy lỗi nguồn này.');
        if (found.rows[0].status !== 'skipped') {
          throw new ApiError(409, 'SOURCE_ISSUE_NOT_SKIPPED', 'Lỗi nguồn không nằm trong mục Đã bỏ qua.');
        }
        await client.query(`UPDATE writing_flow.source_issue
          SET status='open',skipped_at=NULL,skipped_by=NULL,skip_reason=NULL,last_seen_at=now()
          WHERE issue_key=$1`, [issueKey]);
        await client.query(`INSERT INTO writing_flow.operator_event
          (source_id,class_code,source_issue_key,event_type,actor_ref,request_id,reason,
           before_state,after_state)
          VALUES ($1,$2,$3,'source_issue_restored',$4,$5,$6,
            '{"status":"skipped"}'::jsonb,'{"status":"open"}'::jsonb)`,
        [found.rows[0].source_id, found.rows[0].class_code, issueKey,
          actorRef, requestId, reason]);
        return { issueKey, status: 'open', requestId };
      });
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
           AND ${visibleRegistrySql('registry')}
           AND ${visibleOperationalSourceSql('p')}
         GROUP BY p.class_code,p.status,t.teacher_names
         ORDER BY p.class_code,p.status`);
      return result.rows;
    },

    async dashboardCounts({ classCode = null, teacherName = null, sourceKind = null } = {}) {
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
            AND ${visibleOperationalSourceSql('p')}
            AND registry.class_status IS DISTINCT FROM 'completed'
            AND ${visibleRegistrySql('registry')}
            AND ($1::text IS NULL OR p.class_code=$1)
            AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(s.teacher_names,ARRAY[]::text[]),t.teacher_names,ARRAY[]::text[])))
            AND ($4::text IS NULL OR ($4='test' AND p.source_type='term_test')
              OR ($4='homework' AND p.source_type<>'term_test'))
        )
        SELECT stage_key,stage_status,(skipped_at IS NOT NULL) AS skipped,count(*)::integer AS pair_count
        FROM current_pair GROUP BY stage_key,stage_status,(skipped_at IS NOT NULL)
        ORDER BY array_position($3::text[],stage_key),stage_status`,
      [classCode, teacherName, STAGES, sourceKind]);
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
            LEFT JOIN writing_flow.class_registry AS registry
              ON registry.class_code=coalesce(issue.class_code,source.class_code)
            WHERE issue.status='open'
              AND ${visibleOperationalSourceSql('issue')}
              AND registry.class_status IS DISTINCT FROM 'completed'
              AND ${visibleRegistrySql('registry')}
              AND ($1::text IS NULL OR coalesce(issue.class_code,source.class_code)=$1)
              AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(source.teacher_names,ARRAY[]::text[]),
                teachers.teacher_names,ARRAY[]::text[])))
              AND ($3::text IS NULL OR ($3='test' AND source.source_type='term_test')
                OR ($3='homework' AND source.source_type<>'term_test'))) AS source_issues,
          (SELECT count(*)::integer FROM writing_flow.manual_review AS review
            JOIN writing_flow.pair AS pair ON pair.pair_id=review.pair_id
            JOIN writing_flow.stage_result AS review_stage
              ON review_stage.pair_id=review.pair_id
             AND review_stage.stage_key=review.stage_key
             AND review_stage.cycle_no=review.cycle_no
            LEFT JOIN writing_flow.source_record AS source ON source.source_id=pair.source_id
            LEFT JOIN teacher_assignments AS teachers ON teachers.class_code=pair.class_code
            LEFT JOIN writing_flow.class_registry AS registry ON registry.class_code=pair.class_code
            WHERE review.status<>'resolved'
              AND ${visibleOperationalSourceSql('pair')}
              AND review_stage.status='needs_review'
              AND pair.skipped_at IS NULL
              AND pair.status<>'superseded'
              AND ${visibleRegistrySql('registry')}
              AND ($1::text IS NULL OR pair.class_code=$1)
              AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(source.teacher_names,ARRAY[]::text[]),
                teachers.teacher_names,ARRAY[]::text[])))
              AND ($3::text IS NULL OR ($3='test' AND pair.source_type='term_test')
                OR ($3='homework' AND pair.source_type<>'term_test'))) AS reviews,
          (SELECT count(*)::integer FROM writing_flow.workflow_failure
             WHERE last_seen_at>now()-interval '7 days') AS technical_errors`,
      [classCode, teacherName, sourceKind]);
      return { stages: result.rows, support: support.rows[0] };
    },

    async listClassCoverage() {
      const [mapping, seen] = await Promise.all([
        mappingClasses(),
        pool.query(`SELECT class_code,last_scan_at AS last_scanned_at
          FROM writing_flow.class_registry AS registry
          WHERE last_scan_at IS NOT NULL AND ${visibleRegistrySql('registry')}`),
      ]);
      const expected = mapping.filter(item => item.class_code
          && item.operational_state !== 'excluded')
        .map(item => ({ ...item, expected: item.enabled,
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
          event.source_issue_key,
          coalesce(event.class_code,pair.class_code,source.class_code) AS class_code,
          event.event_type,event.actor_ref,event.reason,event.before_state,event.after_state,
          event.created_at
        FROM writing_flow.operator_event AS event
        LEFT JOIN writing_flow.pair AS pair ON pair.pair_id=event.pair_id
        LEFT JOIN writing_flow.source_record AS source ON source.source_id=event.source_id
        LEFT JOIN writing_flow.class_registry AS registry
          ON registry.class_code=coalesce(event.class_code,pair.class_code,source.class_code)
        WHERE ($1::text IS NULL OR coalesce(event.class_code,pair.class_code,source.class_code)=$1)
          AND ($2::text IS NULL OR event.event_type=$2)
          AND ${visibleRegistrySql('registry')}
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
      const rows = mapping.filter(item => item.operational_state !== 'excluded')
        .map(item => ({ ...item, ...(byCode.get(item.class_code) || {}) }));
      if (view === 'active') return rows.filter(row => row.operational_state === 'active');
      if (view === 'completed') return rows.filter(row => row.operational_state === 'completed');
      if (view === 'review') return rows.filter(row => !['active', 'completed', 'excluded']
        .includes(row.operational_state));
      return rows;
    },

    async filterOptions() {
      const [classes, teachers] = await Promise.all([
        pool.query(`SELECT class_code,classroom_name,class_status,mapping_status,enabled
          FROM writing_flow.class_registry AS registry
          WHERE ${visibleRegistrySql('registry')} ORDER BY class_code`),
        pool.query(`SELECT DISTINCT unnest(teacher_names) AS teacher_name
          FROM writing_flow.source_record WHERE cardinality(teacher_names)>0
          ORDER BY teacher_name`),
      ]);
      return { classes: classes.rows, teachers: teachers.rows.map(row => row.teacher_name) };
    },

    // Nhận vào: bộ lọc của biểu đồ ngày, giống bộ lọc bảng bài.
    // Việc chính: đếm riêng lượt chấm mới, lần đầu nhập lịch sử và lượt giao kết quả.
    // Trả ra: từng ngày Việt Nam với ba số độc lập; completed_count giữ hợp đồng cũ.
    // Khi lỗi: API báo lỗi, không đoán số từ dữ liệu tải một phần.
    async dailyStats({ classCode = null, teacherName = null, taskType = null,
      dateFrom = null, dateTo = null, sourceKind = null } = {}) {
      const assignments = await teacherAssignmentsForDatabase();
      const result = await pool.query(`WITH ${assignments},
        legacy_first AS (
          SELECT DISTINCT ON (source_app_id,source_table_id,source_record_id,essay_slot)
            class_code,teacher_name,imported_at
          FROM writing_flow.legacy_record AS history
          WHERE (essay_slot IS NOT NULL OR NOT EXISTS (
            SELECT 1 FROM writing_flow.legacy_record AS slotted
            WHERE slotted.source_app_id=history.source_app_id
              AND slotted.source_table_id=history.source_table_id
              AND slotted.source_record_id=history.source_record_id
              AND slotted.essay_slot IS NOT NULL))
          ORDER BY source_app_id,source_table_id,source_record_id,essay_slot,
            imported_at,legacy_id
        ),
        daily_events AS (
          SELECT to_char((main.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
              'YYYY-MM-DD') AS day,
            1 AS newly_graded_count,0 AS historical_count,0 AS delivered_count
          FROM writing_flow.pair AS p
          JOIN writing_flow.stage_result AS main
            ON main.pair_id=p.pair_id AND main.stage_key='main'
           AND main.status='succeeded' AND main.completed_at IS NOT NULL
          LEFT JOIN writing_flow.test_pair AS task ON task.pair_id=p.pair_id
          LEFT JOIN writing_flow.source_record AS source ON source.source_id=p.source_id
          LEFT JOIN teacher_assignments AS teachers ON teachers.class_code=p.class_code
          LEFT JOIN writing_flow.class_registry AS registry ON registry.class_code=p.class_code
          WHERE coalesce(task.historical_evidence->>'source','') NOT IN
              ('restored_legacy_result','google_docs_result_link')
            AND ${visibleOperationalSourceSql('p')}
            AND ${visibleRegistrySql('registry')}
            AND ($1::text IS NULL OR p.class_code=$1)
            AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(source.teacher_names,ARRAY[]::text[]),
              teachers.teacher_names,ARRAY[]::text[])))
            AND ($3::text IS NULL OR p.task_type=$3)
            AND ($4::date IS NULL OR (main.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= $4)
            AND ($5::date IS NULL OR (main.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= $5)
            AND ($6::text IS NULL OR ($6='test' AND p.source_type='term_test')
              OR ($6='homework' AND p.source_type<>'term_test'))
          UNION ALL
          SELECT to_char((history.imported_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
              'YYYY-MM-DD') AS day,
            0,1,0
          FROM legacy_first AS history
          LEFT JOIN teacher_assignments AS teachers ON teachers.class_code=history.class_code
          LEFT JOIN writing_flow.class_registry AS registry ON registry.class_code=history.class_code
          WHERE ${visibleRegistrySql('registry')}
            AND ($1::text IS NULL OR history.class_code=$1)
            AND ($2::text IS NULL OR history.teacher_name=$2
              OR $2=ANY(coalesce(teachers.teacher_names,ARRAY[]::text[])))
            AND $3::text IS NULL
            AND ($4::date IS NULL OR (history.imported_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= $4)
            AND ($5::date IS NULL OR (history.imported_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= $5)
            AND ($6::text IS NULL OR $6='homework')
          UNION ALL
          SELECT to_char((task.delivered_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
              'YYYY-MM-DD') AS day,
            0,1,0
          FROM writing_flow.test_pair AS task
          JOIN writing_flow.pair AS p ON p.pair_id=task.pair_id
          LEFT JOIN writing_flow.source_record AS source ON source.source_id=p.source_id
          LEFT JOIN teacher_assignments AS teachers ON teachers.class_code=p.class_code
          LEFT JOIN writing_flow.class_registry AS registry ON registry.class_code=p.class_code
          WHERE task.historical_evidence->>'source' IN
              ('restored_legacy_result','google_docs_result_link')
            AND ${visibleOperationalSourceSql('p')}
            AND task.task_score IS NOT NULL AND task.delivered_at IS NOT NULL
            AND ${visibleRegistrySql('registry')}
            AND ($1::text IS NULL OR p.class_code=$1)
            AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(source.teacher_names,ARRAY[]::text[]),
              teachers.teacher_names,ARRAY[]::text[])))
            AND ($3::text IS NULL OR p.task_type=$3)
            AND ($4::date IS NULL OR (task.delivered_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= $4)
            AND ($5::date IS NULL OR (task.delivered_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= $5)
            AND ($6::text IS NULL OR $6='test')
          UNION ALL
          SELECT to_char((deliver.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date,
              'YYYY-MM-DD') AS day,
            0,0,1
          FROM writing_flow.pair AS p
          JOIN writing_flow.stage_result AS deliver
            ON deliver.pair_id=p.pair_id AND deliver.stage_key='deliver'
           AND deliver.status='succeeded' AND deliver.completed_at IS NOT NULL
          LEFT JOIN writing_flow.source_record AS source ON source.source_id=p.source_id
          LEFT JOIN teacher_assignments AS teachers ON teachers.class_code=p.class_code
          LEFT JOIN writing_flow.class_registry AS registry ON registry.class_code=p.class_code
          WHERE p.status='delivered' AND p.skipped_at IS NULL
            AND ${visibleOperationalSourceSql('p')}
            AND ${visibleRegistrySql('registry')}
            AND ($1::text IS NULL OR p.class_code=$1)
            AND ($2::text IS NULL OR $2=ANY(coalesce(nullif(source.teacher_names,ARRAY[]::text[]),
              teachers.teacher_names,ARRAY[]::text[])))
            AND ($3::text IS NULL OR p.task_type=$3)
            AND ($4::date IS NULL OR (deliver.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date >= $4)
            AND ($5::date IS NULL OR (deliver.completed_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date <= $5)
            AND ($6::text IS NULL OR ($6='test' AND p.source_type='term_test')
              OR ($6='homework' AND p.source_type<>'term_test'))
        )
        SELECT day,sum(newly_graded_count)::integer AS newly_graded_count,
          sum(historical_count)::integer AS historical_count,
          sum(delivered_count)::integer AS delivered_count,
          sum(delivered_count)::integer AS completed_count
        FROM daily_events GROUP BY day ORDER BY day`,
      [classCode, teacherName, taskType, dateFrom, dateTo, sourceKind]);
      return result.rows;
    },

    async listPairs({ classCode = null, teacherName = null, stageKey = null,
      stageStatus = null, view = null, includeCompleted = false, taskType = null,
      search = null, searchScope = 'all', dateFrom = null, dateTo = null, limit = 50, offset = 0,
      cursorAt = null, cursorId = null, sort = null, sourceKind = null } = {}) {
      if (encryptionKey && !key) throw new ApiError(503, 'WRITING_FLOW_ENCRYPTION_NOT_READY',
        'Khóa đọc dữ liệu Writing không hợp lệ.');
      const assignments = await teacherAssignmentsForDatabase();
      const searchDocId = documentIdFromSearch(search);
      const normalizedSearch = normalizeWritingSearch(search);
      const sortRules = normalizeWritingSort(sort);
      if (sortRules.length && (cursorAt || cursorId)) {
        throw new ApiError(400, 'WRITING_SORT_CURSOR_UNSUPPORTED',
          'Danh sách đã sắp xếp dùng số trang thay vì con trỏ mặc định.');
      }
      const cursorSql = sortRules.length
        ? '$16::timestamptz IS NULL AND $17::uuid IS NULL'
        : '($16::timestamptz IS NULL OR (p.updated_at,p.pair_id)<($16::timestamptz,$17::uuid))';
      const orderSql = pairOrderSql(sortRules);
      let contentPairIds = [];
      if (search && ['all', 'content'].includes(searchScope) && key) {
        const tokens = writingSearchTokens(search, key);
        if (tokens.length) {
          const candidates = await pool.query(`SELECT pair_id
            FROM writing_flow.pair_search_token
            WHERE token_hash=ANY($1::bytea[])
            GROUP BY pair_id
            HAVING count(DISTINCT token_hash)=$2
            LIMIT 1000`, [tokens, tokens.length]);
          contentPairIds = candidates.rows.map(row => row.pair_id);
        }
      }
      const result = await pool.query(`
        WITH ${assignments}
        SELECT p.pair_id, p.class_code, p.source_app_id, p.source_table_id,
               p.source_record_id, p.homework_file_id,
               p.source_link_index, p.essay_slot, p.task_type, p.status,
               p.source_type,p.created_at,p.updated_at,p.trcc_required_override,
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
               render.result_ciphertext AS render_result_ciphertext,
               repair.status AS trcc_repair_status,
               test_group.test_config,test_group.topology,test_pair.task_number,
               test_pair.historical_evidence,
               test_pair.component_count,test_pair.task_score,test_pair.status AS test_task_status,
               test_final.writing_score,test_final.status AS test_final_status,
               EXISTS (SELECT 1 FROM writing_flow.stage_result AS graded
                 WHERE graded.pair_id=p.pair_id AND graded.stage_key IN ('main','render')
                   AND graded.status='succeeded') AS grading_text_available
          FROM writing_flow.pair AS p
          LEFT JOIN teacher_assignments AS t ON t.class_code=p.class_code
          LEFT JOIN writing_flow.source_record AS s ON s.source_id=p.source_id
          LEFT JOIN writing_flow.class_registry AS registry ON registry.class_code=p.class_code
          LEFT JOIN writing_flow.stage_result AS deliver
            ON deliver.pair_id=p.pair_id AND deliver.stage_key='deliver'
          LEFT JOIN writing_flow.stage_result AS render
            ON render.pair_id=p.pair_id AND render.stage_key='render' AND render.status='succeeded'
          LEFT JOIN writing_flow.trcc_repair AS repair ON repair.pair_id=p.pair_id
          LEFT JOIN writing_flow.test_pair AS test_pair ON test_pair.pair_id=p.pair_id
          LEFT JOIN writing_flow.test_group AS test_group
            ON test_group.test_group_id=test_pair.test_group_id
          LEFT JOIN writing_flow.test_final AS test_final
            ON test_final.test_group_id=test_group.test_group_id
          LEFT JOIN LATERAL (
            SELECT s.stage_key, s.status AS stage_status, s.attempt_count,s.error_code
             FROM writing_flow.stage_result AS s
             WHERE s.pair_id = p.pair_id
               AND s.status IN ('pending','running','needs_review')
             ORDER BY array_position($3::text[],s.stage_key)
             LIMIT 1
          ) AS current_stage ON true
         WHERE ($1::text IS NULL OR p.class_code = $1)
           AND ${visibleOperationalSourceSql('p')}
           AND ($2::text IS NULL OR $2 = ANY(coalesce(nullif(s.teacher_names,ARRAY[]::text[]),t.teacher_names,ARRAY[]::text[])))
           AND p.status<>'superseded'
           AND ${visibleRegistrySql('registry')}
           AND ($7::boolean OR registry.class_status IS DISTINCT FROM 'completed')
           AND ($8::text IS NULL OR p.task_type=$8)
           AND ($9::text IS NULL
             OR ($10::boolean AND (p.homework_file_id=$11
               OR writing_flow.normalize_search(s.student_name)
                 LIKE '%' || writing_flow.normalize_search($9) || '%'))
             OR ($12::boolean AND p.pair_id=ANY($13::uuid[])))
           AND ($14::date IS NULL OR
             (CASE WHEN $6::text='delivered' THEN deliver.completed_at
               ELSE coalesce(s.source_created_at,p.created_at) END)
             >= ($14::date::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'))
           AND ($15::date IS NULL OR
             (CASE WHEN $6::text='delivered' THEN deliver.completed_at
               ELSE coalesce(s.source_created_at,p.created_at) END)
             < (($15::date+1)::timestamp AT TIME ZONE 'Asia/Ho_Chi_Minh'))
           AND ($4::text IS NULL OR coalesce(current_stage.stage_key,
                 CASE WHEN p.status='delivered' THEN 'deliver' ELSE 'intake' END)=$4)
           AND ($5::text IS NULL OR coalesce(current_stage.stage_status,
                 CASE WHEN p.status='delivered' THEN 'succeeded' ELSE 'pending' END)=$5)
           AND ($20::text IS NULL OR ($20='test' AND p.source_type='term_test')
             OR ($20='homework' AND p.source_type<>'term_test'))
           AND (($6::text='skipped' AND p.skipped_at IS NOT NULL)
             OR ($6::text='review' AND p.skipped_at IS NULL
               AND coalesce(current_stage.stage_status,'')='needs_review')
             OR ($6::text='delivered' AND p.status='delivered' AND p.skipped_at IS NULL)
             OR ($6::text='unfinished' AND p.status<>'delivered' AND p.skipped_at IS NULL)
             OR ($6::text IS NULL AND p.skipped_at IS NULL))
           AND ${cursorSql}
         ORDER BY ${orderSql}
         LIMIT $18 OFFSET $19`, [classCode, teacherName, STAGES, stageKey, stageStatus, view,
        includeCompleted, taskType, search, ['all', 'identity', 'docs'].includes(searchScope),
        searchDocId, ['all', 'content'].includes(searchScope), contentPairIds,
        dateFrom, dateTo, cursorAt, cursorId, limit, offset, sourceKind]);
      return result.rows.map(row => {
        let topic = null; let imageUrl = null; let trCcCheck = null; let essayPreview = null;
        let lmsUrl = null; let dataIssueCode = null;
        if (key && row.source_ciphertext) {
          try {
            const decoded = JSON.parse(open(row.source_ciphertext, key));
            topic = decoded[1] || null; imageUrl = decoded[2] || null;
            trCcCheck = row.trcc_required_override === true
              ? true : typeof decoded[4] === 'boolean' ? decoded[4] : null;
            essayPreview = writingSearchPreview(decoded[3]);
          } catch { dataIssueCode = 'SOURCE_DECRYPT_FAILED'; }
        }
        if (key && row.render_result_ciphertext) {
          try {
            const rendered = JSON.parse(open(row.render_result_ciphertext, key));
            const value = String(rendered?.resultUrl || '');
            if (/^https:\/\/ducizone\.ddns\.net\/writing\/shared\/writing-essays\/[a-f0-9]{48}\/view\?v=\d+$/u.test(value)) lmsUrl = value;
          } catch { dataIssueCode ||= 'RESULT_DECRYPT_FAILED'; }
        }
        const legacyRestored = row.source_type === 'term_test'
          && row.historical_evidence?.source === 'restored_legacy_result';
        const { source_ciphertext: _hidden, render_result_ciphertext: _hiddenRender,
          historical_evidence: _hiddenEvidence, ...safe } = row;
        return { ...safe, topic, image_url: imageUrl, tr_cc_check: trCcCheck,
          essay_preview: essayPreview, lms_url: legacyRestored ? null : lmsUrl,
          task_score: legacyRestored ? null : row.task_score,
          writing_score: legacyRestored ? null : row.writing_score,
          grading_text_available: legacyRestored ? false : row.grading_text_available,
          result_origin: legacyRestored ? 'legacy_restored' : 'current',
          data_issue_code: dataIssueCode };
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
           AND ${visibleOperationalSourceSql('p')}
           AND s.status='needs_review'
           AND s.cycle_no=r.cycle_no
           AND p.skipped_at IS NULL
           AND p.status<>'superseded'
           AND registry.class_status IS DISTINCT FROM 'completed'
           AND ${visibleRegistrySql('registry')}
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
