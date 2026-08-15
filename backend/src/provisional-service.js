import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { withTransaction } from './db.js';
import { ApiError } from './service.js';

const scrypt = promisify(crypto.scrypt);
const invisible = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060\ufeff]/gu;

export function normalizeStudentName(value) {
  return String(value ?? '').normalize('NFKC').replace(invisible, '').replace(/\s+/gu, ' ').trim();
}

async function derivePin(pin, salt, pepper) {
  return Buffer.from(await scrypt(`${pin}:${pepper}`, salt, 32, { N: 16384, r: 8, p: 1 }));
}

async function hashPin(pin, pepper) {
  const salt = crypto.randomBytes(16);
  const digest = await derivePin(pin, salt, pepper);
  return { salt: salt.toString('base64'), digest: digest.toString('base64') };
}

async function pinMatches(pin, salt, expected, pepper) {
  const actual = await derivePin(pin, Buffer.from(salt, 'base64'), pepper);
  const stored = Buffer.from(expected, 'base64');
  return actual.length === stored.length && crypto.timingSafeEqual(actual, stored);
}

function aliasFor(name, studentRef) {
  return `${name} · ${studentRef.replaceAll('-', '').slice(0, 4).toUpperCase()}`;
}

export function createProvisionalStudentService({ pool, pepper }) {
  if (!pepper || pepper.length < 32) throw new Error('PROVISIONAL_STUDENT_PIN_PEPPER phải có ít nhất 32 ký tự.');

  async function createStudent({ activitySlug, classRef, displayName, pin, requestId, duplicateConfirmed = false }) {
    const normalized = normalizeStudentName(displayName);
    if (normalized.length < 2 || normalized.length > 100) throw new ApiError(400, 'INVALID_STUDENT_NAME', 'Họ và tên cần có từ 2 đến 100 ký tự.');
    const encoded = await hashPin(pin, pepper);
    return withTransaction(pool, async client => {
      const scope = await client.query(`SELECT activity.id AS activity_id,scope.id AS class_id
        FROM writing_practice.activity activity
        JOIN writing_practice.activity_class_scope scope ON scope.activity_id=activity.id
          AND scope.public_id=$2 AND scope.status='active' AND scope.end_date>=CURRENT_DATE
        WHERE activity.slug=$1 AND activity.status='active' FOR UPDATE OF scope`, [activitySlug, classRef]);
      if (!scope.rowCount) throw new ApiError(404, 'CLASS_NOT_AVAILABLE', 'Lớp hoặc hoạt động chưa được mở.');
      const row = scope.rows[0];
      const prior = await client.query(`SELECT student_public_id AS "studentRef",display_alias AS alias
        FROM writing_practice.provisional_student WHERE activity_class_id=$1 AND registration_request_id=$2`, [row.class_id, requestId]);
      if (prior.rowCount) return { ...prior.rows[0], displayName: normalized, provisional: true, requiresAccessCode: true, idempotent: true };
      const duplicate = await client.query(`SELECT student_public_id AS "studentRef",display_alias AS alias
        FROM writing_practice.provisional_student
        WHERE activity_class_id=$1 AND normalized_name=$2 AND status='pending' ORDER BY created_at LIMIT 1`, [row.class_id, normalized.toLocaleLowerCase('vi')]);
      if (duplicate.rowCount && !duplicateConfirmed) throw new ApiError(409, 'PROVISIONAL_STUDENT_EXISTS', 'Đã có học viên tạm cùng tên. Hãy chọn hồ sơ đó và nhập mã, hoặc xác nhận bạn là người khác cùng tên.', { current: duplicate.rows[0] });
      const sameName = await client.query(`SELECT 1 FROM writing_practice.activity_roster
        WHERE activity_class_id=$1 AND active AND lower(trim(display_name))=$2 LIMIT 1`, [row.class_id, normalized.toLocaleLowerCase('vi')]);
      if (sameName.rowCount && !duplicate.rowCount && !duplicateConfirmed) throw new ApiError(409, 'DUPLICATE_STUDENT_NAME', 'Đã có người cùng tên trong lớp. Nếu đây là một người khác, hãy xác nhận “Tôi là người khác cùng tên”.');
      const pending = await client.query(`SELECT count(*)::int AS total FROM writing_practice.provisional_student
        WHERE activity_class_id=$1 AND status='pending'`, [row.class_id]);
      if (pending.rows[0].total >= 100) throw new ApiError(409, 'PROVISIONAL_CLASS_LIMIT', 'Lớp đã đạt giới hạn hồ sơ tạm. Hãy liên hệ giảng viên.');
      const studentRef = crypto.randomUUID();
      const alias = duplicate.rowCount || sameName.rowCount || duplicateConfirmed ? aliasFor(normalized, studentRef) : normalized;
      await client.query(`INSERT INTO writing_practice.provisional_student
        (activity_class_id,student_public_id,display_name,normalized_name,display_alias,pin_salt,pin_hash,registration_request_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [row.class_id, studentRef, normalized, normalized.toLocaleLowerCase('vi'), alias, encoded.salt, encoded.digest, requestId]);
      await client.query(`INSERT INTO writing_practice.activity_roster
        (activity_class_id,student_public_id,display_name,display_alias,active)
        VALUES($1,$2,$3,$4,true) ON CONFLICT(activity_class_id,student_public_id) DO UPDATE
        SET display_name=EXCLUDED.display_name,display_alias=EXCLUDED.display_alias,active=true,updated_at=now()`, [row.class_id, studentRef, normalized, alias]);
      await client.query(`INSERT INTO writing_practice.provisional_student_audit
        (activity_class_id,student_public_id,action,actor_ref,details)
        VALUES($1,$2,'created','student','{}'::jsonb)`, [row.class_id, studentRef]);
      return { studentRef, displayName: normalized, alias, provisional: true, requiresAccessCode: true, idempotent: false };
    });
  }

  async function resolveStudent(client, { activitySlug, classRef, studentRef, accessCode, lesson = false }) {
    const roster = await client.query(`SELECT activity.id AS activity_id,scope.id AS class_id,
      COALESCE(alias.canonical_student_public_id,roster.student_public_id,$3::uuid) AS canonical_student_ref,
      provisional.status AS provisional_status
      FROM writing_practice.activity activity
      JOIN writing_practice.activity_class_scope scope ON scope.activity_id=activity.id
        AND scope.public_id=$2 AND scope.status='active' AND scope.end_date>=CURRENT_DATE
      LEFT JOIN writing_practice.activity_student_alias alias ON alias.activity_class_id=scope.id
        AND alias.alias_student_public_id=$3
      LEFT JOIN writing_practice.activity_roster roster ON roster.activity_class_id=scope.id
        AND roster.student_public_id=COALESCE(alias.alias_student_public_id,$3) AND roster.active
      LEFT JOIN writing_practice.provisional_student provisional ON provisional.activity_class_id=scope.id
        AND provisional.student_public_id=COALESCE(alias.canonical_student_public_id,$3)
      WHERE activity.slug=$1 AND activity.status='active'
        AND ($4::boolean=false OR activity.grading_pool<>'task1')
        AND (roster.student_public_id IS NOT NULL OR provisional.student_public_id IS NOT NULL)`, [activitySlug, classRef, studentRef, lesson]);
    if (!roster.rowCount) throw new ApiError(404, 'SESSION_NOT_ALLOWED', 'Học viên không thuộc lớp đang hoạt động.');
    const row = roster.rows[0];
    if (row.provisional_status === 'pending') {
      const locked = await client.query(`SELECT pin_salt,pin_hash,failed_pin_attempts,pin_locked_until
        FROM writing_practice.provisional_student WHERE activity_class_id=$1 AND student_public_id=$2 FOR UPDATE`, [row.class_id, row.canonical_student_ref]);
      const credential = locked.rows[0];
      if (credential.pin_locked_until && Date.parse(credential.pin_locked_until) > Date.now()) throw new ApiError(423, 'ACCESS_CODE_LOCKED', 'Mã đang bị khóa 10 phút do nhập sai nhiều lần.');
      const valid = /^\d{4}$/.test(accessCode || '') && await pinMatches(accessCode, credential.pin_salt, credential.pin_hash, pepper);
      if (!valid) {
        const failed = Math.min(5, Number(credential.failed_pin_attempts || 0) + 1);
        await client.query(`UPDATE writing_practice.provisional_student SET failed_pin_attempts=$2::smallint,
          pin_locked_until=CASE WHEN $2::int>=5 THEN now()+interval '10 minutes' ELSE NULL END,updated_at=now()
          WHERE activity_class_id=$1 AND student_public_id=$3`, [row.class_id, failed, row.canonical_student_ref]);
        return { accessError: { status: failed >= 5 ? 423 : 401, code: failed >= 5 ? 'ACCESS_CODE_LOCKED' : 'INVALID_ACCESS_CODE', message: failed >= 5 ? 'Mã đã bị khóa 10 phút.' : 'Mã 4 số không đúng.' } };
      }
      await client.query(`UPDATE writing_practice.provisional_student SET failed_pin_attempts=0,pin_locked_until=NULL,updated_at=now()
        WHERE activity_class_id=$1 AND student_public_id=$2`, [row.class_id, row.canonical_student_ref]);
    }
    return { activityId: row.activity_id, classId: row.class_id, studentRef: row.canonical_student_ref };
  }

  async function listPending({ activitySlug, classRef = null }) {
    const result = await pool.query(`SELECT provisional.student_public_id AS "studentRef",provisional.display_alias AS "displayName",
      scope.public_id AS "classRef",scope.class_name_snapshot AS "className",provisional.status AS "reconciliationStatus",
      provisional.created_at AS "registeredAt"
      FROM writing_practice.provisional_student provisional
      JOIN writing_practice.activity_class_scope scope ON scope.id=provisional.activity_class_id
      JOIN writing_practice.activity activity ON activity.id=scope.activity_id
      WHERE activity.slug=$1 AND provisional.status IN ('pending','conflict')
        AND ($2::uuid IS NULL OR scope.public_id=$2::uuid)
      ORDER BY provisional.created_at`, [activitySlug, classRef]);
    return result.rows;
  }

  async function resetCode({ studentRef, actorRef }) {
    const code = String(crypto.randomInt(0, 10_000)).padStart(4, '0');
    const encoded = await hashPin(code, pepper);
    await withTransaction(pool, async client => {
      const result = await client.query(`UPDATE writing_practice.provisional_student
        SET pin_salt=$2,pin_hash=$3,failed_pin_attempts=0,pin_locked_until=NULL,updated_at=now()
        WHERE student_public_id=$1 AND status='pending' RETURNING activity_class_id`, [studentRef, encoded.salt, encoded.digest]);
      if (!result.rowCount) throw new ApiError(404, 'PROVISIONAL_STUDENT_NOT_FOUND', 'Không tìm thấy hồ sơ tạm cần đặt lại mã.');
      await client.query(`INSERT INTO writing_practice.provisional_student_audit
        (activity_class_id,student_public_id,action,actor_ref,details) VALUES($1,$2,'code_reset',$3,'{}'::jsonb)`, [result.rows[0].activity_class_id, studentRef, actorRef]);
    });
    return { studentRef, accessCode: code };
  }

  async function reconcile({ studentRef, officialStudentRef, actorRef }) {
    return withTransaction(pool, async client => {
      const item = await client.query(`SELECT provisional.activity_class_id,provisional.status,scope.activity_id
        FROM writing_practice.provisional_student provisional
        JOIN writing_practice.activity_class_scope scope ON scope.id=provisional.activity_class_id
        WHERE provisional.student_public_id=$1 FOR UPDATE`, [studentRef]);
      if (!item.rowCount) throw new ApiError(404, 'PROVISIONAL_STUDENT_NOT_FOUND', 'Không tìm thấy hồ sơ tạm.');
      const row = item.rows[0];
      if (row.status !== 'pending' || studentRef === officialStudentRef) throw new ApiError(409, 'PROVISIONAL_STUDENT_NOT_PENDING', 'Hồ sơ này không còn ở trạng thái chờ đối soát.');
      const official = await client.query(`SELECT 1 FROM writing_practice.activity_roster
        WHERE activity_class_id=$1 AND student_public_id=$2 AND active
          AND NOT EXISTS(SELECT 1 FROM writing_practice.provisional_student provisional
            WHERE provisional.activity_class_id=$1 AND provisional.student_public_id=$2)`, [row.activity_class_id, officialStudentRef]);
      if (!official.rowCount) throw new ApiError(404, 'OFFICIAL_STUDENT_NOT_FOUND', 'Không tìm thấy học viên chính thức cùng lớp.');
      const existingAlias = await client.query(`SELECT 1 FROM writing_practice.activity_student_alias
        WHERE activity_class_id=$1 AND alias_student_public_id=$2`, [row.activity_class_id, officialStudentRef]);
      if (existingAlias.rowCount) throw new ApiError(409, 'OFFICIAL_STUDENT_ALREADY_MATCHED', 'Hồ sơ chính thức này đã được ghép với một bài làm khác.');
      const conflict = await client.query(`SELECT 1 FROM writing_practice.activity_session
        WHERE activity_id=$1 AND student_public_id=$2`, [row.activity_id, officialStudentRef]);
      if (conflict.rowCount) throw new ApiError(409, 'RECONCILIATION_CONFLICT', 'Cả hai hồ sơ đều đã có bài làm; hệ thống không tự ghép để tránh mất dữ liệu.');
      await client.query(`INSERT INTO writing_practice.activity_student_alias
        (activity_class_id,alias_student_public_id,canonical_student_public_id,created_by)
        VALUES($1,$2,$3,$4) ON CONFLICT(activity_class_id,alias_student_public_id) DO NOTHING`, [row.activity_class_id, officialStudentRef, studentRef, actorRef]);
      await client.query(`UPDATE writing_practice.provisional_student SET status='matched',matched_student_public_id=$2,
        reconciled_at=now(),reconciled_by=$3,updated_at=now() WHERE student_public_id=$1`, [studentRef, officialStudentRef, actorRef]);
      await client.query(`UPDATE writing_practice.activity_roster SET active=false,updated_at=now()
        WHERE activity_class_id=$1 AND student_public_id=$2`, [row.activity_class_id, studentRef]);
      await client.query(`INSERT INTO writing_practice.provisional_student_audit
        (activity_class_id,student_public_id,action,actor_ref,details)
        VALUES($1,$2,'matched',$3,jsonb_build_object('officialStudentRef',$4::text))`, [row.activity_class_id, studentRef, actorRef, officialStudentRef]);
      return { studentRef, officialStudentRef, reconciliationStatus: 'matched' };
    });
  }

  return { createStudent, resolveStudent, listPending, resetCode, reconcile };
}
