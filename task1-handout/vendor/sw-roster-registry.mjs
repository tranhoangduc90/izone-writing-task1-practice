import { randomUUID } from 'node:crypto';

function problem(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export function normalizeSwRosterName(value) {
  const name = typeof value === 'string' ? value.normalize('NFC').trim().replace(/\s+/gu, ' ') : '';
  if (name.length < 2 || name.length > 100 || /[\p{Cc}\p{Cf}]/u.test(name) || !/\p{L}/u.test(name)) {
    throw problem(400, 'SW_ROSTER_INVALID_NAME', 'Hãy nhập họ và tên của học viên.');
  }
  return { name, key: name.toLocaleLowerCase('vi') };
}

async function transaction(pool, work) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createSwRosterRegistry({ pool }) {
  function serializeMember(row) {
    return {
      studentRef: row.student_ref,
      erpClassId: String(row.erp_class_id),
      displayName: row.display_name,
      active: row.active,
      reconciliationStatus: row.erp_contact_id == null ? 'pending_erp' : 'verified',
    };
  }

  async function add({ scope, actor, requestId, displayName, duplicateConfirmed = false, existingName = false }) {
    const { name, key } = normalizeSwRosterName(displayName);
    return transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`sw-roster:request:${actor}:${requestId}`]);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`sw-roster:name:${scope.erpClassId}:${key}`]);
      const prior = await client.query('SELECT * FROM sw_roster.member WHERE actor_email=$1 AND request_id=$2',
        [actor, requestId]);
      let member = prior.rows[0];
      if (member) {
        if (String(member.erp_class_id) !== String(scope.erpClassId) || member.display_name !== name ||
            member.origin_product !== scope.product || member.origin_activity !== scope.activitySlug ||
            member.origin_class_ref !== scope.classRef) {
          throw problem(409, 'SW_ROSTER_REQUEST_REUSED', 'Mã yêu cầu đã dùng cho thao tác khác.');
        }
      } else {
        const { rowCount } = await client.query(`
          SELECT 1 FROM sw_roster.member WHERE erp_class_id=$1 AND name_key=$2 AND active LIMIT 1`,
        [scope.erpClassId, key]);
        if (!duplicateConfirmed && (existingName || rowCount > 0)) {
          throw problem(409, 'SW_ROSTER_DUPLICATE_NAME', 'Lớp đã có tên này. Xác nhận nếu đây là người khác cùng tên.');
        }
        const result = await client.query(`
          INSERT INTO sw_roster.member
            (student_ref,erp_class_id,display_name,name_key,actor_email,origin_product,origin_activity,origin_class_ref,request_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [randomUUID(), scope.erpClassId, name, key, actor, scope.product, scope.activitySlug, scope.classRef, requestId]);
        member = result.rows[0];
      }
      if (!member.active) {
        throw problem(409, 'SW_ROSTER_MEMBER_INACTIVE', 'Quyền học của hồ sơ này đã được thu hồi.');
      }
      return { member: serializeMember(member), idempotent: Boolean(prior.rowCount) };
    });
  }

  async function findActive({ erpClassId, studentRef }) {
    const { rows: [row] } = await pool.query(`
      SELECT * FROM sw_roster.member WHERE erp_class_id=$1 AND student_ref=$2 AND active`,
    [erpClassId, studentRef]);
    return row ? serializeMember(row) : null;
  }

  async function listActive(erpClassId) {
    const { rows } = await pool.query(`
      SELECT * FROM sw_roster.member WHERE erp_class_id=$1 AND active ORDER BY created_at,student_ref`,
    [erpClassId]);
    return rows.map(serializeMember);
  }

  async function listForClasses(erpClassIds) {
    if (!erpClassIds.length) return [];
    const { rows } = await pool.query(`
      SELECT * FROM sw_roster.member WHERE erp_class_id=ANY($1::bigint[]) ORDER BY created_at,student_ref`,
    [erpClassIds]);
    return rows.map(serializeMember);
  }

  async function recordDelivery(studentRef, product, targets) {
    const { rowCount } = await pool.query(`
      INSERT INTO sw_roster.delivery (student_ref,product,targets) VALUES($1,$2,$3::jsonb)
      ON CONFLICT (student_ref,product) DO UPDATE SET targets=excluded.targets,updated_at=now()
      WHERE sw_roster.delivery.targets IS DISTINCT FROM excluded.targets`,
    [studentRef, product, JSON.stringify(targets)]);
    return rowCount > 0;
  }

  async function listDelivery(erpClassId) {
    const { rows } = await pool.query(`
      SELECT d.student_ref AS "studentRef", d.product, d.targets, d.updated_at AS "updatedAt"
      FROM sw_roster.delivery d JOIN sw_roster.member m ON m.student_ref=d.student_ref
      WHERE m.erp_class_id=$1 AND m.active ORDER BY d.product`, [erpClassId]);
    return rows;
  }

  return { add, findActive, listActive, listForClasses, recordDelivery, listDelivery };
}
