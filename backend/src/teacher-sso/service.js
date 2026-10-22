// Một phiên giảng viên dùng chung, 90 ngày không hoạt động; không chứa bài học viên.
// Chỉ dùng cookie HttpOnly. SQLite giữ hash; các API gốc tiếp tục kiểm quyền lớp.
import {DatabaseSync} from 'node:sqlite';
import {createHmac,randomBytes} from 'node:crypto';
import {digest} from './native-session.js';
const DAY=86400000,NAME='izone_teacher_shared';
export class SsoError extends Error{constructor(code,status){super(code);this.code=code;this.status=status;}}
const fail=(code,status)=>{throw new SsoError(code,status);};
export function createSharedTeacherSession({file,key,sources,clock=Date.now}){
 if(!Buffer.isBuffer(key)||key.length!==32)throw Error('SSO_KEY_REQUIRED');
 const db=new DatabaseSync(file);
 db.exec(`PRAGMA journal_mode=WAL;PRAGMA busy_timeout=3000;
  CREATE TABLE IF NOT EXISTS session(id TEXT PRIMARY KEY,email TEXT NOT NULL,google_subject TEXT NOT NULL,expires_at INTEGER NOT NULL,absolute_expires_at INTEGER NOT NULL,remembered INTEGER NOT NULL,revoked INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS link(session_id TEXT NOT NULL,source TEXT NOT NULL,token_hash TEXT NOT NULL,PRIMARY KEY(session_id,source,token_hash));
  CREATE INDEX IF NOT EXISTS link_hash ON link(source,token_hash);`);
 const parse=(q,name,signed=false)=>{const values=(q.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith(name+'=')).map(s=>s.slice(name.length+1));return values.length===1&&(signed?/^[\w-]{10,8000}\.[\w-]{43}$/:/^[\w-]{43}$/).test(values[0])?values[0]:'';};
 const getSource=id=>sources[id]||fail('SSO_PRODUCT_INVALID',400);
 function write(q,r,name,value,path,row){
  r.cookie(name,value,{httpOnly:true,secure:q.secure,partitioned:q.secure,sameSite:q.secure?'none':'lax',path,
   ...(!value?{maxAge:0}:row.remembered?{maxAge:Math.max(0,row.expires_at-clock())}:{})});
 }
 function read(q){
  const value=parse(q,NAME);if(!value)return null;
  const row=db.prepare('SELECT * FROM session WHERE id=? AND revoked=0 AND expires_at>? AND absolute_expires_at>?').get(digest(value),clock(),clock());
  return row?{...row,value}:null;
 }
 function renew(row){
  if(row.remembered)row.expires_at=Math.min(row.absolute_expires_at,clock()+90*DAY);
  db.prepare('UPDATE session SET expires_at=? WHERE id=? AND revoked=0').run(row.expires_at,row.id);
  return row;
 }
 function rememberLink(row,id,hash){db.prepare('INSERT OR IGNORE INTO link VALUES(?,?,?)').run(row.id,id,hash);}
 async function revoke(row){
  db.prepare('UPDATE session SET revoked=1 WHERE id=?').run(row.id);
  const links=db.prepare('SELECT source,token_hash FROM link WHERE session_id=?').all(row.id);
  // Giữ links sau thu hồi để một cookie cũ còn sót không tự mở phiên chung lại.
  const results=await Promise.allSettled(links.map(link=>getSource(link.source).native.revokeHash(link.token_hash)));
  if(results.some(r=>r.status==='rejected'))fail('SSO_LOGOUT_INCOMPLETE',503);
 }
 async function bridge(q,r,id,{replace=false}={}){
  const source=getSource(id),existing=read(q);
  if(existing&&!replace){write(q,r,NAME,existing.value,'/',renew(existing));return {ok:true};}
  const nativeValue=parse(q,source.cookieName,source.kind==='identity');if(!nativeValue||!source.native)fail('SSO_LOGIN_REQUIRED',401);
  const denied=db.prepare('SELECT 1 FROM link l JOIN session s ON s.id=l.session_id WHERE l.source=? AND l.token_hash=? AND s.revoked=1').get(id,digest(nativeValue));
  if(denied)fail('SSO_LOGIN_REQUIRED',401);
  const identity=await source.native.read(nativeValue);
  if(!identity?.email||!identity.google_subject)fail('SSO_LOGIN_REQUIRED',401);
  // Đăng nhập mới phải tôn trọng lựa chọn ghi nhớ mới, kể cả cùng tài khoản.
  if(existing)await revoke(existing);
  const remembered=identity.remembered===true,absolute=Date.parse(identity.absolute_expires_at),now=clock();
  if(!Number.isFinite(absolute)||absolute<=now)fail('SSO_LOGIN_REQUIRED',401);
  if(db.prepare('SELECT count(*) AS n FROM session WHERE revoked=0 AND expires_at>?').get(now).n>=10000)fail('SSO_CAPACITY',503);
  const value=randomBytes(32).toString('base64url');
  const row={id:digest(value),value,email:identity.email.toLowerCase(),google_subject:identity.google_subject,
   expires_at:Math.min(absolute,now+(remembered?90*DAY:3600000)),absolute_expires_at:Math.min(absolute,now+(remembered?365*DAY:3600000)),remembered:+remembered};
  db.prepare('INSERT INTO session(id,email,google_subject,expires_at,absolute_expires_at,remembered) VALUES(?,?,?,?,?,?)').run(row.id,row.email,row.google_subject,row.expires_at,row.absolute_expires_at,row.remembered);
  rememberLink(row,id,digest(nativeValue));write(q,r,NAME,value,'/',row);return {ok:true};
 }
 async function restore(q,r,id){
  const source=getSource(id),row=read(q);if(!row)fail('SSO_LOGIN_REQUIRED',401);
  renew(row);
  // Consumer độc lập xác minh lại phiên chung và quyền riêng ở mỗi yêu cầu.
  if(source.kind==='identity'){write(q,r,NAME,row.value,'/',row);return {ok:true};}
  const token=createHmac('sha256',key).update(id+'\0'+row.value).digest('base64url');
  rememberLink(row,id,digest(token));
  const permitted=await source.native.issue(token,{...row,remembered:!!row.remembered,expires_at:new Date(row.expires_at).toISOString(),absolute_expires_at:new Date(row.absolute_expires_at).toISOString()});
  if(!permitted)fail('SSO_ACCESS_DENIED',403);
  if(!db.prepare('SELECT 1 FROM session WHERE id=? AND revoked=0 AND expires_at>?').get(row.id,clock())){
   await source.native.revokeHash(digest(token));fail('SSO_LOGIN_REQUIRED',401);
  }
  write(q,r,source.cookieName,token,source.cookiePath,row);write(q,r,NAME,row.value,'/',row);
  return {ok:true};
 }
 async function logout(q,r){
  // Phiên đã hết hạn cũng phải thu hồi những liên kết còn giữ cookie native.
  const value=parse(q,NAME),row=value&&db.prepare('SELECT * FROM session WHERE id=?').get(digest(value));
  if(row)await revoke(row);
  for(const source of Object.values(sources))if(source.cookieName)write(q,r,source.cookieName,'',source.cookiePath,{});
  write(q,r,NAME,'','/',{});return {ok:true};
 }
 // Chỉ nhận payload Google đã được endpoint xác minh chữ ký và audience.
 async function login(q,r,payload,remember=true){
  if(!payload?.sub||typeof payload.email!=='string'||payload.email_verified!==true)fail('SSO_GOOGLE_INVALID',401);
  const previous=read(q);if(previous)await revoke(previous);
  const value=randomBytes(32).toString('base64url'),now=clock();
  const row={id:digest(value),value,email:payload.email.toLowerCase(),google_subject:payload.sub,
   expires_at:now+(remember?90*DAY:3600000),absolute_expires_at:now+(remember?365*DAY:3600000),remembered:+remember};
  if(db.prepare('SELECT count(*) AS n FROM session WHERE revoked=0 AND expires_at>?').get(now).n>=10000)fail('SSO_CAPACITY',503);
  db.prepare('INSERT INTO session(id,email,google_subject,expires_at,absolute_expires_at,remembered) VALUES(?,?,?,?,?,?)').run(row.id,row.email,row.google_subject,row.expires_at,row.absolute_expires_at,row.remembered);
  write(q,r,NAME,value,'/',row);return {ok:true};
 }
 function inspect(q){const row=read(q);if(!row)fail('SSO_LOGIN_REQUIRED',401);return {email:row.email,google_subject:row.google_subject,expires_at:new Date(row.expires_at).toISOString()};}
 return {bridge,restore,logout,login,inspect,close:()=>db.close()};
}
