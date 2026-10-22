// Chỉ nhận cookie cũ sau khi API gốc kiểm chữ ký và tài khoản bằng khóa bootstrap riêng.
export function createRemoteNative({url,cookieName,bootstrapKey,fetcher=fetch,clock=Date.now}){
 return {
  async read(value){
   const response=await fetcher(url,{headers:{Cookie:cookieName+'='+value,'X-Izone-Sso-Bootstrap':bootstrapKey},signal:AbortSignal.timeout(5000)});
   if(response.status===401||response.status===403)return null;
   if(!response.ok)throw Error('SSO_SOURCE_UNAVAILABLE');
   const data=await response.json();let payload;try{payload=JSON.parse(Buffer.from(value.split('.')[0],'base64url').toString('utf8'));}catch{return null;}
   if(data.reviewer?.email?.toLowerCase()!==payload.email?.toLowerCase()||typeof payload.sub!=='string'||!Number.isSafeInteger(payload.exp)||payload.exp<=clock())return null;
   return {email:payload.email.toLowerCase(),google_subject:payload.sub,expires_at:new Date(payload.exp).toISOString(),absolute_expires_at:new Date(clock()+365*86400000).toISOString(),remembered:true};
  },
  async revokeHash(){/* Khi bật SSO, API gốc không nhận cookie cũ ngoài đường bootstrap. */}
 };
}
