import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';

const secretPattern = /^[A-Za-z0-9_-]{43}$/u;

function problem(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
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

export function createSwRosterRegistry({ pool, invitationKey, invitationTtlSeconds = 1200 }) {
  if (!pool || !invitationKey || Buffer.byteLength(invitationKey) < 32 ||
      !Number.isSafeInteger(invitationTtlSeconds) || invitationTtlSeconds < 1) {
    throw new Error('SW_ROSTER_REGISTRY_CONFIG_INVALID');
  }

  const invitationToken = ref => createHmac('sha256', invitationKey)
    .update('sw-roster-invitation:v1:')
    .update(ref)
    .digest('base64url');

  function serializeMember(row) {
    return {
      studentRef: row.student_ref,
      erpClassId: String(row.erp_class_id),
      displayName: row.display_name,
      active: row.active,
      reconciliationStatus: row.erp_contact_id == null ? 'pending_erp' : 'verified',
    };
  }

  async function findInvitation(client, actor, requestId) {
    const result = await client.query(`
      SELECT *, expires_at > now() AND redeemed_at IS NULL AS usable
      FROM sw_roster.invitation WHERE actor_email=$1 AND request_id=$2`,
    [actor, requestId]);
    return result.rows[0];
  }

  async function issueInvitation(client, member, scope, actor, requestId) {
    const prior = await findInvitation(client, actor, requestId);
    if (prior) {
      if (prior.student_ref !== member.student_ref || prior.product !== scope.product ||
          prior.activity_slug !== scope.activitySlug || prior.class_ref !== scope.classRef) {
        throw problem(409, 'SW_ROSTER_REQUEST_REUSED', 'Mã yêu cầu đã dùng cho thao tác khác.');
      }
      return invitationResult(prior);
    }
    const ref = randomUUID();
    const { rows: [row] } = await client.query(`
      INSERT INTO sw_roster.invitation
        (invitation_ref,student_ref,actor_email,request_id,product,activity_slug,class_ref,token_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,now()+$9::int*interval '1 second')
      RETURNING invitation_ref,token_hash,expires_at,true AS usable`,
    [ref, member.student_ref, actor, requestId, scope.product, scope.activitySlug, scope.classRef,
      digest(invitationToken(ref)), invitationTtlSeconds]);
    return invitationResult(row);
  }

  function invitationResult(row) {
    const token = row.usable ? invitationToken(row.invitation_ref) : null;
    return {
      invitationToken: token && digest(token) === row.token_hash ? token : null,
      invitationExpiresAt: row.expires_at,
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
      const invitation = await issueInvitation(client, member, scope, actor, requestId);
      return { member: serializeMember(member), ...invitation, idempotent: Boolean(prior.rowCount) };
    });
  }

  async function reissue({ scope, actor, requestId, studentRef }) {
    return transaction(pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`sw-roster:request:${actor}:${requestId}`]);
      const { rows: [member] } = await client.query(`
        SELECT * FROM sw_roster.member WHERE student_ref=$1 AND erp_class_id=$2 AND active FOR UPDATE`,
      [studentRef, scope.erpClassId]);
      if (!member) throw problem(404, 'SW_ROSTER_MEMBER_NOT_FOUND', 'Không tìm thấy hồ sơ còn quyền học trong lớp.');
      if (!await findInvitation(client, actor, requestId)) {
        await client.query(`
          UPDATE sw_roster.invitation SET expires_at=now()
          WHERE student_ref=$1 AND product=$2 AND activity_slug=$3 AND class_ref=$4
            AND redeemed_at IS NULL AND expires_at>now()`,
        [studentRef, scope.product, scope.activitySlug, scope.classRef]);
      }
      const invitation = await issueInvitation(client, member, scope, actor, requestId);
      return { member: serializeMember(member), ...invitation };
    });
  }

  async function redeem({ scope, token }) {
    if (!secretPattern.test(token || '')) {
      throw problem(401, 'SW_ROSTER_INVITATION_INVALID', 'Liên kết vào bài không hợp lệ hoặc đã được dùng.');
    }
    const credential = randomBytes(32).toString('base64url');
    const { rows: [row] } = await pool.query(`
      UPDATE sw_roster.invitation i
      SET redeemed_at=now(), credential_hash=$1
      FROM sw_roster.member m
      WHERE i.token_hash=$2 AND i.product=$3 AND i.activity_slug=$4 AND i.class_ref=$5
        AND i.redeemed_at IS NULL AND i.expires_at>now()
        AND m.student_ref=i.student_ref AND m.erp_class_id=$6 AND m.active
      RETURNING m.*`,
    [digest(credential), digest(token), scope.product, scope.activitySlug, scope.classRef, scope.erpClassId]);
    if (!row) throw problem(401, 'SW_ROSTER_INVITATION_INVALID', 'Liên kết vào bài không hợp lệ hoặc đã được dùng.');
    return { member: serializeMember(row), credential };
  }

  async function invitationMember({ scope, token }) {
    if (!secretPattern.test(token || '')) return null;
    const { rows: [row] } = await pool.query(`
      SELECT m.* FROM sw_roster.invitation i
      JOIN sw_roster.member m ON m.student_ref=i.student_ref
      WHERE i.token_hash=$1 AND i.product=$2 AND i.activity_slug=$3 AND i.class_ref=$4
        AND i.redeemed_at IS NULL AND i.expires_at>now() AND m.erp_class_id=$5 AND m.active`,
    [digest(token), scope.product, scope.activitySlug, scope.classRef, scope.erpClassId]);
    return row ? serializeMember(row) : null;
  }

  async function canAccess({ erpClassId, studentRef, credential }) {
    if (!secretPattern.test(credential || '')) return false;
    const { rowCount } = await pool.query(`
      SELECT 1 FROM sw_roster.member m
      JOIN sw_roster.invitation i ON i.student_ref=m.student_ref
      WHERE m.erp_class_id=$1 AND m.student_ref=$2 AND m.active
        AND i.credential_hash=$3 LIMIT 1`,
    [erpClassId, studentRef, digest(credential)]);
    return rowCount > 0;
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

  return { add, reissue, redeem, invitationMember, canAccess, listActive, listForClasses, recordDelivery, listDelivery };
}
