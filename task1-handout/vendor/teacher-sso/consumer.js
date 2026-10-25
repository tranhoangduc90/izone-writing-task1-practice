// Nhận cookie từ API sản phẩm; chỉ chuyển cookie chung tới máy chủ xác thực nội bộ.
// Không giữ quyền lớp trong cache. Lỗi dịch vụ không trở thành đăng nhập thành công.
export function createSharedTeacherVerifier({url,key,fetcher=fetch}){
 if(!url||!key)throw Error('SSO_CONSUMER_CONFIG_REQUIRED');
 return async request=>{
  const values=(request.headers.cookie||'').split(';').map(s=>s.trim()).filter(s=>s.startsWith('izone_teacher_shared='));
  if(values.length!==1||!/^izone_teacher_shared=[\w-]{43}$/.test(values[0]))throw Object.assign(Error('SSO_LOGIN_REQUIRED'),{status:401,code:'SSO_LOGIN_REQUIRED'});
  let response,value;
  try{response=await fetcher(url,{method:'POST',headers:{Cookie:values[0],'X-Izone-Sso-Consumer':key},signal:AbortSignal.timeout(5000)});if(response.ok)value=await response.json();}
  catch{throw Object.assign(Error('SSO_UNAVAILABLE'),{status:503,code:'SSO_UNAVAILABLE'});}
  if(!response.ok)throw Object.assign(Error(response.status===401?'SSO_LOGIN_REQUIRED':'SSO_UNAVAILABLE'),{status:response.status===401?401:503,code:response.status===401?'SSO_LOGIN_REQUIRED':'SSO_UNAVAILABLE'});
  if(typeof value.email!=='string'||typeof value.google_subject!=='string'||!value.email||!value.google_subject)throw Object.assign(Error('SSO_UNAVAILABLE'),{status:503,code:'SSO_UNAVAILABLE'});
  return {sub:value.google_subject,email:value.email,emailVerified:true};
 };
}
