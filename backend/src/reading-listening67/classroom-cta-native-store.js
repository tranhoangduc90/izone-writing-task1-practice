import { randomUUID } from 'node:crypto';

const terminal = new Set(['ready', 'review', 'error', 'skipped', 'held']);
function required(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

// Operator-only handoff. Running or ambiguous deliveries still require a readback.
export async function releaseUnstartedK67CtaJobs(pool, { courseId, classCode, drainingEpoch }) {
  const { rows } = await pool.query(`
    WITH safe AS (
      SELECT job.dispatch_token,job.source_id FROM reading_listening67.cta_native_job job
      JOIN reading_listening67.source_document source ON source.source_id=job.source_id
      JOIN reading_listening67.cta_native_owner authority ON authority.course_id=source.course_id
      WHERE authority.course_id=$1 AND authority.class_code=$2 AND authority.owner='draining' AND authority.epoch=$3
        AND source.class_code=$2 AND source.cta_state='pending' AND source.cta_execution_id IS NULL
        AND source.cta_dispatch_token=job.dispatch_token AND job.state='queued' AND job.epoch<$3
      FOR UPDATE OF job,source
    ), held AS (
      UPDATE reading_listening67.cta_native_job job SET state='held',finished_at=now(),error_code='CTA_ROLLBACK_UNSTARTED'
      FROM safe WHERE job.dispatch_token=safe.dispatch_token RETURNING job.dispatch_token,job.source_id
    )
    UPDATE reading_listening67.source_document source SET cta_enqueued_at=NULL
    FROM held WHERE source.source_id=held.source_id AND source.cta_dispatch_token=held.dispatch_token
    RETURNING source.source_id`, [courseId, classCode, drainingEpoch]);
  return { released: rows.length };
}

export function createK67NativeStore({ pool }) {
  async function ownership({ courseId, classCode, epoch }) {
    const { rows } = await pool.query("SELECT epoch FROM reading_listening67.cta_native_owner"
      + " WHERE course_id=$1 AND class_code=$2 AND owner='backend'", [courseId, classCode]);
    return rows.length === 1 && (epoch === undefined || rows[0].epoch === epoch) ? rows[0].epoch : null;
  }

  return {
    ownership,
    async enrollScope({ courseId, classCode, erpClassId, observedAt }) {
      const { rows } = await pool.query(
        'SELECT status,epoch FROM reading_listening67.enroll_cta_native_scope($1,$2,$3,$4)',
        [courseId, classCode, erpClassId, observedAt],
      );
      const [result] = rows;
      const accepted = ['enrolled', 'existing'].includes(result?.status);
      required(rows.length === 1 && (accepted ? Number.isInteger(result.epoch) && result.epoch > 0
        : ['invalid_evidence', 'disabled', 'n8n', 'draining', 'identity_conflict', 'legacy_present'].includes(result?.status)
          && result.epoch === null), 'CTA_ENROLLMENT_RECEIPT_INVALID');
      return result;
    },
    async ownsScope(scope) {
      return scope.epoch !== undefined && (await ownership(scope)) === scope.epoch;
    },
    async checkedUnchanged(sources) {
      const inputs = sources.map(({ documentId, classroom: c }) => ({
        documentId, courseId: c.courseId, courseworkId: c.courseworkId, submissionId: c.submissionId,
        studentId: c.studentId, classCode: c.classCode, homeworkTitle: c.homeworkTitle,
        sourceVersion: c.sourceVersion, sourceEventId: c.sourceEventId,
      }));
      const { rows } = await pool.query(`
        SELECT source.document_id AS "documentId", source.course_id AS "courseId",
          source.coursework_id AS "courseworkId", source.submission_id AS "submissionId"
        FROM jsonb_to_recordset($1::jsonb) AS input("documentId" text,"courseId" text,"courseworkId" text,
          "submissionId" text,"studentId" text,"classCode" text,"homeworkTitle" text,"sourceVersion" text,"sourceEventId" text)
        JOIN reading_listening67.source_document source ON source.document_id=input."documentId"
          AND source.course_id=input."courseId" AND source.coursework_id=input."courseworkId"
          AND source.submission_id=input."submissionId"
        WHERE source.cta_pipeline_version >= 2 AND source.cta_state IN ('ready','review')
          AND source.source_version=input."sourceVersion" AND source.student_id=input."studentId"
          AND source.class_code=input."classCode" AND source.source_event_id=input."sourceEventId"
          AND source.homework_title IS NOT DISTINCT FROM input."homeworkTitle"`, [JSON.stringify(inputs)]);
      return rows.map(row => ({ ...row, saved: true, ctaNeeded: false }));
    },
    async manualSource(documentId) {
      const { rows } = await pool.query(`
        SELECT source.course_id,source.coursework_id,source.class_code,source.student_id,source.submission_id,
          source.cta_state,source.cta_proof,source.cta_enqueued_at,authority.epoch,authority.owner,
          authority.class_code AS owner_class_code
        FROM reading_listening67.source_document source
        LEFT JOIN reading_listening67.cta_native_owner authority ON authority.course_id=source.course_id
        WHERE source.document_id=$1 ORDER BY source.source_id LIMIT 2`, [documentId]);
      if (!rows.length) return { status: 'source_not_found' };
      if (rows.length !== 1 || !rows[0].student_id || !rows[0].submission_id) return { status: 'source_ambiguous' };
      const row = rows[0];
      const current = row.owner === 'backend' && row.owner_class_code === row.class_code;
      return { status: current ? 'eligible' : 'legacy_owner', epoch: current ? row.epoch : null,
        courseId: row.course_id, courseWorkId: row.coursework_id, classCode: row.class_code,
        state: row.cta_state, proof: row.cta_proof, enqueued: Boolean(row.cta_enqueued_at) };
    },
    async publish(job) {
      const { source, dispatchToken, epoch, runId } = job;
      const c = source.classroom;
      const { rows } = await pool.query(`
        INSERT INTO reading_listening67.cta_native_job AS job(dispatch_token, source_id, run_id, epoch, state)
        SELECT source.cta_dispatch_token, source.source_id, $8, $9, 'queued'
        FROM reading_listening67.source_document source
        JOIN reading_listening67.cta_native_owner authority ON authority.course_id=source.course_id
        WHERE source.document_id=$1 AND source.course_id=$2 AND source.coursework_id=$3 AND source.submission_id=$4
          AND source.student_id=$5 AND source.class_code=$6 AND source.cta_dispatch_token=$7
          AND source.cta_state='pending' AND source.cta_lease_until>now() AND source.source_version=$10
          AND authority.class_code=source.class_code AND authority.owner='backend' AND authority.epoch=$9
        ON CONFLICT(dispatch_token) DO UPDATE SET run_id=job.run_id
          WHERE job.source_id=EXCLUDED.source_id AND job.epoch=EXCLUDED.epoch
        RETURNING dispatch_token`, [source.documentId, c.courseId, c.courseworkId, c.submissionId, c.studentId,
        c.classCode, dispatchToken, runId, epoch, c.sourceVersion]);
      return { confirmed: rows.length === 1, dispatchToken: rows[0]?.dispatch_token };
    },
    async claim() {
      const leaseToken = randomUUID();
      const { rows } = await pool.query(`
        WITH candidate AS (
          SELECT job.dispatch_token
          FROM reading_listening67.cta_native_job job
          JOIN reading_listening67.source_document source USING(source_id)
          JOIN reading_listening67.cta_native_owner authority ON authority.course_id=source.course_id
          WHERE (job.state='queued' OR (job.state='running' AND job.lease_until<=now()))
            AND authority.class_code=source.class_code AND authority.owner='backend' AND authority.epoch=job.epoch
          ORDER BY job.enqueued_at, job.dispatch_token LIMIT 1 FOR UPDATE OF job SKIP LOCKED
        )
        UPDATE reading_listening67.cta_native_job job
        SET state='running', lease_token=$1, lease_until=now()+interval '4 minutes'
        FROM candidate, reading_listening67.source_document source
        WHERE job.dispatch_token=candidate.dispatch_token AND source.source_id=job.source_id
        RETURNING job.dispatch_token,job.run_id,job.epoch,source.document_id,source.course_id,source.coursework_id,
          source.submission_id,source.student_id,source.class_code,source.homework_title,source.source_version,source.source_event_id`,
      [leaseToken]);
      const row = rows[0];
      if (!row) return null;
      return {
        dispatchToken: row.dispatch_token, runId: row.run_id, epoch: row.epoch, leaseToken,
        executionId: 'cta-job-' + row.dispatch_token,
        source: { documentId: row.document_id, classroom: { courseId: row.course_id, courseworkId: row.coursework_id,
          submissionId: row.submission_id, studentId: row.student_id, classCode: row.class_code,
          homeworkTitle: row.homework_title, sourceVersion: row.source_version, sourceEventId: row.source_event_id } },
      };
    },
    async settle(job, result) {
      required(terminal.has(result.state), 'CTA_NATIVE_RESULT_INVALID');
      const reason = /^[A-Z0-9_|-]{1,200}$/.test(result.errorCode || '') ? result.errorCode : null;
      const { rows } = await pool.query(`
        UPDATE reading_listening67.cta_native_job SET state=$3,lease_token=NULL,lease_until=NULL,finished_at=now(),error_code=$4
        WHERE dispatch_token=$1 AND state='running' AND lease_token=$2 AND lease_until>now() RETURNING state`,
      [job.dispatchToken, job.leaseToken, result.state, reason]);
      required(rows.length === 1 && rows[0].state === result.state, 'CTA_NATIVE_RECEIPT_UNSAVED');
      return { state: rows[0].state };
    },
    async deferBusyDocument(job) {
      // The document lock failed before the processor claimed or changed the source.
      const { rowCount } = await pool.query(`
        UPDATE reading_listening67.cta_native_job
        SET state='queued',lease_token=NULL,lease_until=NULL,error_code='CTA_DOCUMENT_BUSY'
        WHERE dispatch_token=$1 AND state='running' AND lease_token=$2 AND lease_until>now()`,
      [job.dispatchToken, job.leaseToken]);
      required(rowCount === 1, 'CTA_NATIVE_RECEIPT_UNSAVED');
    },
    async ownsJob(job) {
      const { rows } = await pool.query('SELECT 1 FROM reading_listening67.cta_native_job'
        + " WHERE dispatch_token=$1 AND state='running' AND lease_token=$2 AND lease_until>now()",
      [job.dispatchToken, job.leaseToken]);
      return rows.length === 1;
    },
    async withSlot(time, handler) {
      required(time instanceof Date && Number.isFinite(time.getTime()) && time.getTime() % (15 * 60_000) === 0,
        'CTA_NATIVE_SLOT_INVALID');
      const client = await pool.connect();
      const lock = 'rl67:cta-native-scheduler';
      let held = false, releaseError;
      try {
        held = (await client.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS held', [lock])).rows[0]?.held === true;
        if (!held) return { status: 'busy' };
        const runId = randomUUID();
        const claimed = await client.query(`
          INSERT INTO reading_listening67.cta_native_slot AS slot(slot_at,run_id,status)
          VALUES ($1,$2,'running') ON CONFLICT(slot_at) DO UPDATE SET
          run_id=EXCLUDED.run_id,status='running',started_at=now(),finished_at=NULL
          WHERE slot.status='running' RETURNING run_id`, [time, runId]);
        if (!claimed.rows.length) return { status: 'already_run' };
        let status = 'failure';
        try {
          const result = await handler(runId);
          required(['done', 'partial'].includes(result.status), 'CTA_NATIVE_SLOT_RESULT_INVALID');
          status = result.status;
          return result;
        } finally {
          await client.query('UPDATE reading_listening67.cta_native_slot SET status=$3,finished_at=now() WHERE slot_at=$1 AND run_id=$2',
            [time, runId, status]);
        }
      } finally {
        if (held) {
          try {
            const result = await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0)) AS released', [lock]);
            required(result.rows[0]?.released === true, 'CTA_NATIVE_SLOT_UNLOCK_FAILED');
          } catch (error) { releaseError = error; }
        }
        client.release(releaseError);
        if (releaseError) throw releaseError;
      }
    },
  };
}
