function scopeResult(row, product) {
  return {
    product,
    classRef: row.class_ref,
    erpClassId: String(row.erp_class_id),
    classCode: row.class_code,
    activitySlug: row.slug,
    title: row.title,
  };
}

function projectionConflict() {
  return Object.assign(new Error('Phát hiện định danh hoặc bí danh đã được sử dụng ở bài này.'), {
    code: 'SW_ROSTER_PROJECTION_CONFLICT',
    status: 409,
  });
}

export function createSwRosterProjection({ pool, product }) {
  if (!['task1', 'task2'].includes(product)) throw new Error('SW_ROSTER_PRODUCT_INVALID');
  const eligibleScopes = `
    SELECT c.id, a.id AS activity_id, c.public_id AS class_ref, c.erp_course_class_id AS erp_class_id,
      c.class_name_snapshot AS class_code, a.slug, a.title
    FROM writing_practice.activity_class_scope c
    JOIN writing_practice.activity a ON a.id=c.activity_id
    WHERE a.grading_pool=$1 AND a.status='active' AND c.status='active'
      AND c.end_date>=CURRENT_DATE AND c.class_name_snapshot LIKE 'CS.%'`;

  async function resolveScope(activitySlug, classRef) {
    const { rows: [row] } = await pool.query(`${eligibleScopes} AND a.slug=$2 AND c.public_id=$3`,
      [product, activitySlug, classRef]);
    return row ? scopeResult(row, product) : null;
  }

  async function listScopes(erpClassId = null, activitySlug = null) {
    const { rows } = await pool.query(`${eligibleScopes}
      AND ($2::bigint IS NULL OR c.erp_course_class_id=$2)
      AND ($3::text IS NULL OR a.slug=$3) ORDER BY a.slug,c.id`,
    [product, erpClassId, activitySlug]);
    return rows.map(row => scopeResult(row, product));
  }

  async function apply(scope, member) {
    if (scope.product !== product || String(scope.erpClassId) !== String(member.erpClassId) || !member.active) {
      throw projectionConflict();
    }
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [target] } = await client.query(`
        ${eligibleScopes} AND a.slug=$2 AND c.public_id=$3 AND c.erp_course_class_id=$4
        FOR SHARE OF a FOR NO KEY UPDATE OF c`, [product, scope.activitySlug, scope.classRef, scope.erpClassId]);
      if (!target) {
        throw Object.assign(new Error('Bài hoặc lớp này đã đóng.'), { code: 'SW_ROSTER_SCOPE_CLOSED', status: 404 });
      }
      const prior = await client.query(`
        SELECT r.active FROM sw_roster.projection p
        LEFT JOIN writing_practice.activity_roster r
          ON r.activity_class_id=p.activity_class_id AND r.student_public_id=p.student_ref
        WHERE p.activity_class_id=$1 AND p.student_ref=$2`, [target.id, member.studentRef]);
      const alias = `${member.displayName} · ${member.studentRef.replaceAll('-', '').slice(0, 12)}`;
      if (prior.rowCount && !prior.rows[0].active) {
        // Preserve the durable ownership marker even if an older roster loader removed its row.
        await client.query(`
          INSERT INTO writing_practice.activity_roster
            (activity_class_id,student_public_id,display_name,display_alias,active)
          VALUES($1,$2,$3,$4,true)
          ON CONFLICT (activity_class_id,student_public_id)
          DO UPDATE SET active=true,updated_at=now()`,
        [target.id, member.studentRef, member.displayName, alias]);
      } else if (!prior.rowCount) {
        const created = await client.query(`
          WITH added AS (
            INSERT INTO writing_practice.activity_roster
              (activity_class_id,student_public_id,display_name,display_alias,active)
            SELECT $1,$2,$3,$4,true
            WHERE NOT EXISTS (
              SELECT 1 FROM writing_practice.activity_session s
              WHERE s.activity_id=$5 AND s.student_public_id=$2
            ) AND NOT EXISTS (
              SELECT 1 FROM writing_practice.activity_student_alias a
              WHERE a.activity_class_id=$1 AND (a.alias_student_public_id=$2 OR a.canonical_student_public_id=$2)
            )
            ON CONFLICT DO NOTHING
            RETURNING activity_class_id,student_public_id
          )
          INSERT INTO sw_roster.projection (activity_class_id,student_ref)
          SELECT activity_class_id,student_public_id FROM added RETURNING student_ref`,
        [target.id, member.studentRef, member.displayName, alias, target.activity_id]);
        if (!created.rowCount) throw projectionConflict();
      }
      await client.query('COMMIT');
      return { classRef: scope.classRef, studentRef: member.studentRef };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function managedStudent(classRef, studentRef) {
    const { rows: [row] } = await pool.query(`
      SELECT p.student_ref, c.erp_course_class_id AS erp_class_id, c.status='active' AND c.end_date>=CURRENT_DATE
        AND a.status='active' AND COALESCE(r.active,false) AS open
      FROM sw_roster.projection p
      JOIN writing_practice.activity_class_scope c ON c.id=p.activity_class_id
      JOIN writing_practice.activity a ON a.id=c.activity_id
      LEFT JOIN writing_practice.activity_roster r
        ON r.activity_class_id=p.activity_class_id AND r.student_public_id=p.student_ref
      LEFT JOIN writing_practice.activity_student_alias alias ON alias.activity_class_id=c.id
        AND alias.alias_student_public_id=$2
      WHERE c.public_id=$1 AND p.student_ref=COALESCE(alias.canonical_student_public_id,$2)`, [classRef, studentRef]);
    return row ? { erpClassId: String(row.erp_class_id), studentRef: row.student_ref, open: row.open } : null;
  }

  async function ownerOf(kind, ref) {
    const attempt = kind === 'attempt';
    const source = attempt
      ? 'writing_practice.check_attempt x JOIN writing_practice.activity_session s ON s.id=x.session_id'
      : 'writing_practice.activity_session s';
    const { rows: [row] } = await pool.query(`
      SELECT c.public_id AS "classRef", c.erp_course_class_id AS "erpClassId",
        s.student_public_id AS "studentRef", a.slug AS "activitySlug",
        c.status='active' AND c.end_date>=CURRENT_DATE AND a.status='active' AND COALESCE(r.active,false) AS open
      FROM ${source}
      JOIN sw_roster.projection p ON p.activity_class_id=s.activity_class_id AND p.student_ref=s.student_public_id
      JOIN writing_practice.activity_class_scope c ON c.id=s.activity_class_id
      JOIN writing_practice.activity a ON a.id=c.activity_id
      LEFT JOIN writing_practice.activity_roster r ON r.activity_class_id=p.activity_class_id AND r.student_public_id=p.student_ref
      WHERE ${attempt ? 'x' : 's'}.public_id=$1`, [ref]);
    return row || null;
  }

  async function listProjected(scopes) {
    if (!scopes.length) return [];
    const { rows } = await pool.query(`
      SELECT c.public_id AS "classRef", p.student_ref AS "studentRef", COALESCE(r.active,false) AS active
      FROM sw_roster.projection p
      JOIN writing_practice.activity_class_scope c ON c.id=p.activity_class_id
      LEFT JOIN writing_practice.activity_roster r ON r.activity_class_id=c.id AND r.student_public_id=p.student_ref
      WHERE c.public_id=ANY($1::uuid[])`, [scopes.map(scope => scope.classRef)]);
    return rows;
  }

  async function deactivate(scope, studentRef) {
    await pool.query(`
      UPDATE writing_practice.activity_roster r SET active=false,updated_at=now()
      FROM sw_roster.projection p JOIN writing_practice.activity_class_scope c ON c.id=p.activity_class_id
      WHERE c.public_id=$1 AND p.student_ref=$2
        AND r.activity_class_id=p.activity_class_id AND r.student_public_id=p.student_ref AND r.active`,
    [scope.classRef, studentRef]);
  }

  return { resolveScope, listScopes, apply, managedStudent, ownerOf, listProjected, deactivate };
}
