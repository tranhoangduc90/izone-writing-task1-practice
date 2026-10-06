// Nhận biến chỉ có tiền tố HANDOUT67; kiểm đúng database/role trước khi mở cổng.
// Không đọc DATABASE_URL hay cấu hình Writing chung; thiếu cấu hình thì dừng, không fallback.
export function config(env=process.env) {
  const must = name => {const v=env[name];if(!v)throw new Error(`Thiếu ${name}`);return v;};
  const databaseUrl=must('HANDOUT67_DATABASE_URL');
  const url=new URL(databaseUrl);
  if(!['postgres:','postgresql:'].includes(url.protocol) || decodeURIComponent(url.pathname)!=='/handout_writing67' || decodeURIComponent(url.username)!=='handout67_runtime')throw new Error('HANDOUT67_DATABASE_URL phải dùng database handout_writing67 và role handout67_runtime.');
  const origins=must('HANDOUT67_ALLOWED_ORIGINS').split(',').map(v=>v.trim());
  if(origins.some(v=>!/^https:\/\/[^/]+$/.test(v) && !/^http:\/\/127\.0\.0\.1:\d+$/.test(v)))throw new Error('Origin phải cụ thể, không wildcard.');
  const port=Number(env.HANDOUT67_PORT||'3187');
  if(port!==3187)throw new Error('Port không hợp lệ.');
  const secret=must('HANDOUT67_SESSION_SECRET'),internalSecret=must('HANDOUT67_INTERNAL_SECRET');
  if(secret.length<32||internalSecret.length<32||secret===internalSecret)throw new Error('Cần hai secret riêng, tối thiểu 32 ký tự.');
  const rosterUrl=new URL(must('HANDOUT67_ROSTER_URL'));
  if(rosterUrl.protocol!=='https:')throw new Error('Roster production phải dùng HTTPS.');
  const classes=must('HANDOUT67_ALLOWED_CLASSES').split(',').map(v=>v.trim());
  if(classes.some(v=>!v)||!classes.length)throw new Error('Phải khai phạm vi lớp.');
  const wakeUrl=new URL(must('HANDOUT67_N8N_WAKE_URL'));
  const wakeSecret=must('HANDOUT67_N8N_WAKE_SECRET');
  if(wakeUrl.protocol!=='https:' || wakeSecret.length<32 || [secret,internalSecret].includes(wakeSecret))throw new Error('Cần webhook HTTPS và secret đánh thức riêng.');
  const promptFile=must('HANDOUT67_PROMPT_FILE');
  const teacherFile=env.HANDOUT67_TEACHER_FILE||null;
  const teacherSecret=teacherFile?must('HANDOUT67_TEACHER_SECRET'):null;
  if(teacherFile&&(teacherSecret.length<32||[secret,internalSecret,wakeSecret].includes(teacherSecret)))throw new Error('Cần secret giảng viên riêng.');
  const gatewayUrl=env.HANDOUT67_AI_GATEWAY_URL||null,gatewayToken=env.HANDOUT67_AI_GATEWAY_TOKEN||null;
  if(Boolean(gatewayUrl)!==Boolean(gatewayToken)||gatewayUrl&&(new URL(gatewayUrl).protocol!=='https:'||gatewayToken.length<32||/[\r\n]/.test(gatewayToken)))throw new Error('Cần URL HTTPS và khóa Cổng AI riêng cho Handout67.');
  return {databaseUrl,origins,port,secret,internalSecret,rosterUrl:rosterUrl.href,classes,promptFile,wakeUrl:wakeUrl.href,wakeSecret,teacherFile,teacherSecret,gatewayUrl,gatewayToken};
}

export function rosterAdapter({rosterUrl,classes}, fetcher=fetch) {
  return async ()=>{
    const response=await fetcher(rosterUrl,{signal:AbortSignal.timeout(5000),redirect:'error'});
    if(!response.ok)throw Object.assign(new Error('ROSTER_UNAVAILABLE'),{status:503});
    const value=await response.json();
    if(value.ok!==true || !Array.isArray(value.classes))throw Object.assign(new Error('ROSTER_CONTRACT_INVALID'),{status:503});
    // Dạng v1 hiện có: classRef/className/students. Không cho học viên provisional vượt PIN.
    const rows=value.classes.filter(c=>classes.includes(c.classRef) && Array.isArray(c.students)).map(c=>({classRef:c.classRef,className:c.className,students:c.students.filter(s=>!s.requiresAccessCode&&!s.provisional).map(s=>({studentRef:s.studentRef,displayName:s.displayName||s.alias}))}));
    if(rows.some(c=>typeof c.classRef!=='string'||typeof c.className!=='string'||c.students.some(s=>typeof s.studentRef!=='string'||typeof s.displayName!=='string')))throw Object.assign(new Error('ROSTER_CONTRACT_INVALID'),{status:503});
    return rows;
  };
}
