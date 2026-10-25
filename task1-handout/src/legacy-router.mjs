// Route by activity and immutable UUIDs; unrelated products retain their old API.
export async function ownsRequest(pool,path,body={}){
 const slug=path.match(/^\/api\/v1\/(?:admin\/(?:live\/)?activities|activities)\/([^/]+)/)?.[1]||body.activitySlug;
 if(slug){const r=await pool.query("SELECT 1 FROM writing_practice.activity WHERE slug=$1 AND grading_pool='task1'",[decodeURIComponent(slug)]);return Boolean(r.rowCount);}
 const match=path.match(/^\/api\/v1\/(?:admin\/(?:live\/)?)?(sessions|lesson-sessions|attempts|teacher-comments|provisional-students)\/([0-9a-f-]{36})(?:\/|$)/i);if(!match)return false;
 const types={'sessions':['activity_session','public_id'],'lesson-sessions':['activity_session','public_id'],'attempts':['check_attempt','public_id'],'teacher-comments':['teacher_comment_thread','public_id'],'provisional-students':['provisional_student','student_public_id']};
 const [table,key]=types[match[1].toLowerCase()];if(!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(match[2]))return false;
 const r=await pool.query(`SELECT 1 FROM writing_practice.${table} WHERE ${key}=$1 LIMIT 1`,[match[2]]);
 return Boolean(r.rowCount);
}
export function legacyRouter(pool,oldBase){
 return async(q,r,next)=>{
  try{
   const chunks=[];let size=0;for await(const chunk of q){size+=chunk.length;if(size>131072)return r.status(413).json({ok:false,error:'BODY_TOO_LARGE'});chunks.push(chunk);}const raw=Buffer.concat(chunks);
   let body={};if(raw.length&&q.get('content-type')?.includes('application/json')){try{body=JSON.parse(raw);}catch{}}
   const owned=await ownsRequest(pool,q.path,body),target=new URL(owned?'http://127.0.0.1:8790/':oldBase);target.pathname=q.path;target.search=new URL(q.url,'http://router.invalid').search;
   const headers={...q.headers};for(const k of ['host','connection','content-length','transfer-encoding','accept-encoding'])delete headers[k];
   const response=await fetch(target,{method:q.method,headers,...(!['GET','HEAD'].includes(q.method)&&raw.length?{body:raw}:{}),redirect:'manual',signal:AbortSignal.timeout(30000)});
   r.status(response.status);for(const [k,v] of response.headers)if(!['transfer-encoding','connection','content-encoding','content-length','set-cookie'].includes(k))r.set(k,v);
   const cookies=response.headers.getSetCookie();if(cookies.length)r.set('set-cookie',cookies);
   r.send(Buffer.from(await response.arrayBuffer()));
  }catch(e){next(e);}
 };
}
