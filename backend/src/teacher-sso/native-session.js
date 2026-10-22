// Nhận danh tính đã được phiên máy chủ xác minh; chỉ đọc/ghi bảng phiên đăng nhập.
// Quyền lớp và quyền thao tác vẫn được API sản phẩm kiểm lại như trước.
import {createHash} from 'node:crypto';
export const digest=value=>createHash('sha256').update(value).digest('hex');
const valid=value=>typeof value==='string'&&/^[\w-]{43}$/.test(value);
export function createNativeSession({pool,kind,schema}){
 if(!['reading_practice','listening_practice','reading_listening67','mapping'].includes(schema))throw Error('SSO_SCHEMA_INVALID');
 const mapping=kind==='reviewer',materials=kind==='materials';
 const table=schema+'.'+(mapping?'reviewer_session':materials?'web_teacher_session':'teacher_session');
 const hash=value=>mapping?Buffer.from(digest(value),'hex'):digest(value);
 async function read(value){
  if(!valid(value))return null;
  const sql=mapping?`SELECT s.reviewer_email AS email,s.google_subject,s.idle_expires_at AS expires_at,s.absolute_expires_at,true AS remembered
   FROM ${table} s JOIN mapping.reviewer_account a ON a.email=s.reviewer_email AND a.google_subject=s.google_subject
   WHERE s.token_hash=$1 AND s.revoked_at IS NULL AND s.idle_expires_at>now() AND s.absolute_expires_at>now()
   AND a.status='active' AND a.role IN ('admin','teacher')`:
   `SELECT email,google_subject,expires_at,absolute_expires_at,remembered FROM ${table} WHERE token_hash=$1 AND expires_at>now() AND absolute_expires_at>now()`;
  return (await pool.query(sql,[hash(value)])).rows[0]||null;
 }
 async function issue(value,identity){
  if(!valid(value))throw Error('SSO_TOKEN_INVALID');
  if(mapping){
   const account=await pool.query(`UPDATE mapping.reviewer_account SET google_subject=COALESCE(google_subject,$2),last_login_at=now(),updated_at=now()
    WHERE email=$1 AND status='active' AND role IN ('admin','teacher') AND (google_subject IS NULL OR google_subject=$2) RETURNING email`,[identity.email,identity.google_subject]);
   if(account.rows.length!==1)return false;
   await pool.query(`INSERT INTO ${table}(token_hash,reviewer_email,google_subject,idle_expires_at,absolute_expires_at)
    VALUES($1,$2,$3,$4,$5) ON CONFLICT(token_hash) DO UPDATE SET idle_expires_at=EXCLUDED.idle_expires_at,absolute_expires_at=EXCLUDED.absolute_expires_at
    WHERE ${table}.revoked_at IS NULL AND ${table}.reviewer_email=EXCLUDED.reviewer_email AND ${table}.google_subject=EXCLUDED.google_subject`,
   [hash(value),identity.email,identity.google_subject,identity.expires_at,identity.absolute_expires_at]);
  }else await pool.query(`INSERT INTO ${table}(token_hash,email,google_subject,expires_at,absolute_expires_at,remembered)
    VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(token_hash) DO UPDATE SET expires_at=EXCLUDED.expires_at
    WHERE ${table}.email=EXCLUDED.email AND ${table}.google_subject=EXCLUDED.google_subject`,
   [hash(value),identity.email,identity.google_subject,identity.expires_at,identity.absolute_expires_at,identity.remembered]);
  return true;
 }
 async function revokeHash(hex){
  if(!/^[a-f0-9]{64}$/.test(hex))throw Error('SSO_HASH_INVALID');
  await pool.query(`DELETE FROM ${table} WHERE token_hash=$1`,[mapping?Buffer.from(hex,'hex'):hex]);
 }
 return {read,issue,revokeHash};
}
