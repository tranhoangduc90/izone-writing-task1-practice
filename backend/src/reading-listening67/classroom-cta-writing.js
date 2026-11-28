import { createHash, randomUUID } from 'node:crypto';

function requireWriting(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
const numeric = /^[1-9][0-9]{0,19}$/;
const codePattern = /^[a-zA-Z0-9_-]{4,100}$/;
const pendingCourseworkCodes = ['hw-writing-67-than-bai-mua-sam-khong-can-thiet','hw-writing-67-handout-lesson-7'];
const cleanCode = (error, fallback) => /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : fallback;

export function createK67WritingRegistry({ pool, useReadonlyView = false, classCodes }) {
  requireWriting(classCodes === undefined || (Array.isArray(classCodes) && classCodes.length > 0
    && classCodes.every(code => typeof code === 'string' && /^IC[0-9]+$/.test(code))
    && new Set(classCodes).size === classCodes.length), 'CTA_WRITING_CLASS_ALLOWLIST_INVALID');
  const allowed = classCodes && new Set(classCodes);
  const registry = useReadonlyView ? 'cta_shared_k67.assignments' : 'assignments';
  return async scope => {
    requireWriting(numeric.test(scope.courseId || '') && numeric.test(scope.erpClassId || ''), 'CTA_WRITING_SCOPE_INVALID');
    if (allowed && !allowed.has(scope.classCode)) return [];
    const { rows } = await pool.query(`
      SELECT id::text,definition->'classroom'->>'courseWorkId' AS "courseWorkId",
        definition->'classroom'->>'ctaCode' AS "assignmentCode",definition->>'contentVersion' AS version
      FROM ${registry} WHERE definition->'classroom'->>'courseId'=$1 AND definition->>'authorityClassId'=$2
        AND NOT COALESCE(definition->'classroom'->>'ctaCode'=ANY($3::text[]) AND definition->'classroom'->'courseWorkId'='null'::jsonb,false)
      ORDER BY id LIMIT 11`, [scope.courseId, scope.erpClassId, pendingCourseworkCodes]);
    requireWriting(rows.length <= 10, 'CTA_WRITING_REGISTRY_OVER_LIMIT');
    const keys = new Set();
    for (const row of rows) {
      const key = row.courseWorkId + ':' + row.assignmentCode;
      requireWriting(numeric.test(row.courseWorkId || '') && numeric.test(row.version || '')
        && codePattern.test(row.assignmentCode || '') && !keys.has(key), 'CTA_WRITING_REGISTRY_INVALID');
      keys.add(key);
    }
    return rows;
  };
}

export function createK67WritingSourceLane({ pool, readRegistry, submit, ownsScope, log = () => {} }) {
  function exactEvent({ documentId, classroom: c }) {
    return { doc_id: documentId, classroom_course_id: c.courseId, coursework_id: c.courseworkId,
      submission_id: c.submissionId, student_id: c.studentId, class_name: c.classCode };
  }
  return {
    async discover(scope, sources) {
      if (!scope.shared) return { queued: 0 };
      const registry = await readRegistry(scope);
      if (!registry.length) return { queued: 0 };
      const candidate = [];
      for (const source of sources) {
        const attachments = registry.filter(item => item.courseWorkId === source.classroom.courseworkId);
        if (!attachments.length) continue;
        const event = exactEvent(source);
        requireWriting(event.classroom_course_id === scope.courseId && event.class_name === scope.classCode,
          'CTA_WRITING_SOURCE_MISMATCH');
        const key = createHash('sha256').update(JSON.stringify([event, source.classroom.sourceVersion, attachments])).digest('hex');
        candidate.push({ key, event });
      }
      let queued = 0;
      for (let offset = 0; offset < candidate.length; offset += 20) {
        requireWriting(await ownsScope(scope) === true, 'CTA_SCOPE_NOT_OWNED');
        const { rows } = await pool.query(`
          INSERT INTO reading_listening67.cta_native_writing_source(source_key,course_id,class_code,epoch,event)
          SELECT input.key,$1,$2,$3,input.event FROM jsonb_to_recordset($4::jsonb) AS input(key text,event jsonb)
          JOIN reading_listening67.cta_native_owner authority ON authority.course_id=$1 AND authority.class_code=$2
            AND authority.owner='backend' AND authority.epoch=$3
          ON CONFLICT(source_key) DO NOTHING RETURNING source_key`, [scope.courseId, scope.classCode, scope.epoch,
          JSON.stringify(candidate.slice(offset, offset + 20))]);
        queued += rows.length;
      }
      return { queued };
    },
    async workOnce() {
      await pool.query(`
        UPDATE reading_listening67.cta_native_writing_source w SET state='review',
          lease_token=NULL,lease_until=NULL,error_code='CTA_WRITING_ATTEMPTS_EXHAUSTED'
        FROM reading_listening67.cta_native_owner authority
        WHERE w.course_id=authority.course_id AND w.class_code=authority.class_code
          AND w.epoch=authority.epoch AND authority.owner='backend'
          AND w.state='running' AND w.attempts>=8 AND w.lease_until<=now()`);
      const token = randomUUID();
      const { rows } = await pool.query(`
        WITH next AS (
          SELECT w.source_key FROM reading_listening67.cta_native_writing_source w
          JOIN reading_listening67.cta_native_owner authority USING(course_id,class_code)
          WHERE authority.owner='backend' AND authority.epoch=w.epoch AND w.attempts<8
            AND ((w.state='pending' AND w.eligible_at<=now()) OR (w.state='running' AND w.lease_until<=now()))
          ORDER BY w.eligible_at,w.source_key LIMIT 1 FOR UPDATE OF w SKIP LOCKED
        )
        UPDATE reading_listening67.cta_native_writing_source w SET state='running',lease_token=$1,
          lease_until=now()+interval '4 minutes',attempts=w.attempts+1
          FROM next WHERE w.source_key=next.source_key RETURNING w.*`, [token]);
      const job = rows[0];
      if (!job) return { status: 'idle' };
      if (await ownsScope({ courseId: job.course_id, classCode: job.class_code, epoch: job.epoch }) !== true) {
        return { status: 'held' };
      }
      let status, errorCode;
      try {
        const result = await submit(job.event);
        requireWriting(result?.ok === true && result.documentId === job.event.doc_id
          && ['verified', 'not_applicable'].includes(result.status), 'CTA_WRITING_RECEIPT_INVALID');
        status = result.status;
      } catch (error) {
        errorCode = cleanCode(error, 'CTA_WRITING_OUTCOME_UNKNOWN');
        status = job.attempts >= 8 ? 'review' : 'pending';
      }
      const receipt = await pool.query(`
        UPDATE reading_listening67.cta_native_writing_source SET state=$3,error_code=$4,lease_token=NULL,lease_until=NULL,
          eligible_at=now()+($5::int*interval '1 minute')
        WHERE source_key=$1 AND lease_token=$2 AND lease_until>now() RETURNING state`,
      [job.source_key, token, status, errorCode ?? null, Math.min(120, 5 * 2 ** (job.attempts - 1))]);
      requireWriting(receipt.rows.length === 1, 'CTA_WRITING_RECEIPT_UNSAVED');
      log({ stage: 'writing', sourceTag: job.source_key.slice(0, 20), status, errorCode });
      return { status };
    },
  };
}
