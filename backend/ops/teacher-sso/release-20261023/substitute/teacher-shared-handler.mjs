// Bao quanh API giảng viên hiện hành: cookie chung xác minh người, API gốc kiểm quyền.
// Không đổi đường học viên, nộp/chấm/Portal; không cache danh tính hoặc quyền lớp.
export function createSharedTeacherHandler({handle,createHandle,verifyShared,allowedOrigin}){
 return async request=>{
  const path=new URL(request.path,'http://substitute.internal').pathname;
  if(!path.startsWith('/teacher/'))return handle(request);
  const cors=request.headers?.origin===allowedOrigin?{'access-control-allow-origin':allowedOrigin,'access-control-allow-credentials':'true',vary:'Origin'}:{};
  const reply=(status,body)=>({status,headers:{...cors,'cache-control':'no-store'},body});
  if(request.headers?.origin&&request.headers.origin!==allowedOrigin)return reply(403,{code:'ORIGIN_DENIED'});
  if(request.method==='OPTIONS')return {status:204,headers:{...cors,'access-control-allow-methods':'GET','access-control-allow-headers':'Authorization'},body:null};
  if(request.method!=='GET')return reply(405,{code:'METHOD_NOT_ALLOWED'});
  if(path==='/teacher/config'){const result=await handle(request);return {...result,headers:{...result.headers,...cors}};}
  try{
   const principal=await verifyShared({headers:request.headers||{}});
   // Giá trị này chỉ ở máy chủ; không phải credential có thể dùng từ trình duyệt.
   const result=await createHandle(async()=>principal)({...request,headers:{...request.headers,authorization:'Bearer shared-verified-on-server'}});
   return {...result,headers:{...result.headers,...cors}};
  }catch(error){return reply(error.status===401?401:503,{code:error.status===401?'LOGIN_REQUIRED':'SSO_UNAVAILABLE'});}
 };
}
