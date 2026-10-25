// Preview uses the existing SW identity source; all class/data permissions stay local.
// No central config change and no credential is accepted as a self-declared identity.
export function createPreviewAuth({pool,nativeAuth,fetchImpl=fetch}){
 const origin='https://tranhoangduc90.github.io';
 const broker='http://izone-teacher-session:8962';
 const reject=(r,status=401)=>r.status(status).json({ok:false,error:status===403?'ACCESS_DENIED':'UNAUTHORIZED'});
 async function authenticate(q,r,next){
  try{
   const shared=String(q.get('cookie')||'').split(';').map(x=>x.trim()).find(x=>/^izone_teacher_shared=[A-Za-z0-9_-]{43}$/.test(x));
   if(!shared)return nativeAuth.authenticate(q,r,next);
   if(!['GET','HEAD'].includes(q.method)&&(q.get('origin')!==origin||q.get('x-izone-csrf')!=='1'))return reject(r,403);
   const response=await fetchImpl(broker+'/v1/restore/shops',{method:'POST',headers:{Origin:origin,'X-Izone-Csrf':'1','Content-Type':'application/json',Cookie:shared},body:'{}',signal:AbortSignal.timeout(10000),redirect:'error'});
   if(!response.ok)return reject(r,response.status===403?403:response.status===401?401:503);
   const cookies=response.headers.getSetCookie();
   const native=cookies.find(c=>c.startsWith('izone_shops_teacher='))?.split(';')[0];
   if(!native)return reject(r,503);
   const identity=await fetchImpl('http://shops-writing-api:8790/api/v1/auth/session',{headers:{Cookie:native,Origin:origin},signal:AbortSignal.timeout(10000),redirect:'error'});
   if(!identity.ok)return reject(r,identity.status===403?403:401);
   const verified=(await identity.json()).reviewer;
   const account=await pool.query("SELECT email,display_name,role FROM mapping.reviewer_account WHERE email=$1 AND status='active' AND role IN ('admin','teacher')",[verified?.email]);
   if(account.rowCount!==1)return reject(r,403);
   const a=account.rows[0];q.reviewer={email:a.email,displayName:a.display_name,role:a.role,canManage:a.role==='admin',canAccessAllClasses:a.role==='admin'};
   q.authSource='shared-sw';
   for(const c of cookies)if(c.startsWith('izone_teacher_shared='))r.append('Set-Cookie',c);
   next();
  }catch(e){next(Object.assign(Error('Chưa xác minh được phiên giảng viên dùng chung.'),{status:503,code:'SSO_UNAVAILABLE'}));}
 }
 async function logout(q,r){
  const response=await fetchImpl(broker+'/v1/logout',{method:'POST',headers:{Origin:origin,'X-Izone-Csrf':'1','Content-Type':'application/json',Cookie:q.get('cookie')||''},body:'{}',signal:AbortSignal.timeout(10000),redirect:'error'});
  if(!response.ok)return reject(r,503);
  for(const c of response.headers.getSetCookie())r.append('Set-Cookie',c);
  return nativeAuth.logout(q,r);
 }
 return {authenticate,logout,login:(_q,r)=>r.status(409).json({ok:false,error:'USE_SHARED_SW_LOGIN'})};
}
