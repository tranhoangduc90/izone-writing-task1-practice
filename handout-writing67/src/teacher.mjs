import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {fail,ORDER,FIELDS,publicTeacherComments} from './service.mjs';
import {publicThreads,changeThread} from './comments.mjs';

// Nhận danh tính Google đã xác minh và quyền lớp riêng; chỉ đọc/ghi bảng Handout67.
// Token giảng viên có secret riêng. Không trả job/prompt/lease/capability cho dashboard.
export function createTeacher({db,store,roster,registry,secret,verifyGoogleToken,clock=Date.now}) {
  if(typeof secret!=='string'||secret.length<32)fail('TEACHER_CONFIG_INVALID');
  const sign=value=>createHmac('sha256',secret).update(value).digest('base64url');
  function account(email,sub){
    const found=registry().teachers.filter(t=>t.email===email && typeof t.subject==='string' && t.subject.length>0 && t.subject===sub);
    if(found.length!==1)fail('TEACHER_FORBIDDEN',403);
    return {...found[0],subject:sub};
  }
  const publicActor=a=>({displayName:a.displayName,email:a.email,classes:a.classes});
  async function context(actor,classRef){
    if(!actor.classes.includes(classRef))fail('TEACHER_FORBIDDEN',403);
    const row=(await roster()).find(c=>c.classRef===classRef);
    if(!row)fail('CLASS_NOT_OPEN',404);
    return row;
  }
  async function sessionFor(actor,ref){
    const s=await store.read(ref);if(!s)fail('SESSION_NOT_FOUND',404);
    const row=await context(actor,s.classRef);
    if(s.activity!=='lesson5'||!row.students.some(x=>x.studentRef===s.studentRef))fail('TEACHER_FORBIDDEN',403);
    return s;
  }
  const publicSession=s=>({ref:s.ref,classRef:s.classRef,studentRef:s.studentRef,version:s.version,responses:s.responses,steps:s.steps,vocabulary:s.vocabulary,idea2Open:s.idea2Open,teacherComments:publicTeacherComments(s),commentThreads:publicThreads(s),commentVersion:s.commentVersion||0});
  return {
    clientId:()=>registry().clientId,
    async login(credential){
      if(typeof credential!=='string'||credential.length>8192)fail('TEACHER_UNAUTHORIZED',401);
      let p;
      try{p=await verifyGoogleToken(credential,registry().clientId);}catch{fail('TEACHER_UNAUTHORIZED',401);}
      if(!p?.sub || p.email_verified!==true || typeof p.email!=='string' || !(p.hd||p.email.endsWith('@gmail.com')))fail('TEACHER_UNAUTHORIZED',401);
      const actor=account(p.email.toLowerCase(),p.sub);
      const body=Buffer.from(JSON.stringify({email:actor.email,sub:p.sub,exp:clock()+43200000})).toString('base64url');
      return {token:body+'.'+sign(body),reviewer:publicActor(actor)};
    },
    authorize(token){
      if(typeof token!=='string'||token.length>8192)fail('TEACHER_UNAUTHORIZED',401);
      const [body,sig,...extra]=token.split('.');const expected=sign(body||'');
      if(extra.length||!sig||Buffer.byteLength(sig)!==Buffer.byteLength(expected)||!timingSafeEqual(Buffer.from(sig),Buffer.from(expected)))fail('TEACHER_UNAUTHORIZED',401);
      let p;try{p=JSON.parse(Buffer.from(body,'base64url'));}catch{fail('TEACHER_UNAUTHORIZED',401);}
      if(!Number.isSafeInteger(p.exp)||p.exp<=clock()||typeof p.email!=='string'||typeof p.sub!=='string')fail('TEACHER_UNAUTHORIZED',401);
      return account(p.email,p.sub);
    },
    actor:publicActor,
    async classes(actor){return (await roster()).filter(c=>actor.classes.includes(c.classRef)).map(c=>({classRef:c.classRef,className:c.className,studentCount:c.students.length}));},
    async summary(actor,classRef){
      const row=await context(actor,classRef);
      const result=await db.query("SELECT payload,updated_at FROM handout67.session WHERE payload->>'classRef'=$1 AND payload->>'activity'='lesson5'",[classRef]);
      const sessions=new Map(result.rows.map(r=>[r.payload.studentRef,r]));
      return {classRef,className:row.className,students:row.students.map(student=>{
        const r=sessions.get(student.studentRef),s=r?.payload;
        return {...student,sessionRef:s?.ref||null,updatedAt:r?.updated_at||null,passed:s?ORDER.filter(k=>s.steps[k].status==='passed').length:0,steps:s?Object.fromEntries(ORDER.map(k=>[k,s.steps[k].status])):{},comments:s?(s.teacherComments||[]).length+(s.commentThreads||[]).length:0};
      })};
    },
    async detail(actor,ref){return publicSession(await sessionFor(actor,ref));},
    // Quyền lớp/roster lấy lại từ backend; không lấy học viên/lớp hoặc quyền từ query client.
    async activity(actor,ref,query={}){await sessionFor(actor,ref);return store.audit.read(ref,query);},
    async thread(actor,ref,input){
      if(input?.expectedActor!==actor.email)fail('TEACHER_IDENTITY_CHANGED',401);
      await sessionFor(actor,ref);
      return store.edit(ref,s=>{
        if(!actor.classes.includes(s.classRef))fail('TEACHER_FORBIDDEN',403);
        changeThread(s,{role:'teacher',key:actor.email,name:actor.displayName},input,clock());
        return publicSession(s);
      });
    },
    async comment(actor,ref,input){
      if(input?.expectedActor!==actor.email)fail('TEACHER_IDENTITY_CHANGED',401);
      if(!input || !Number.isSafeInteger(input.expectedVersion)||!ORDER.includes(input.section)||typeof input.feedback!=='string'||!input.feedback.trim()||input.feedback.length>4000||typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId))fail('TEACHER_COMMENT_INVALID');
      await sessionFor(actor,ref);
      return store.edit(ref,s=>{
        // Đọc lại định danh trong transaction; không lấy studentRef/classRef từ body ghi nhận xét.
        if(!actor.classes.includes(s.classRef))fail('TEACHER_FORBIDDEN',403);
        s.teacherComments ||= [];
        const previous=s.teacherComments.find(c=>c.requestId===input.requestId&&c.authorEmail===actor.email);
        if(previous){if(previous.section!==input.section||previous.feedback!==input.feedback.trim()||previous.expectedVersion!==input.expectedVersion)fail('REQUEST_ID_CONFLICT',409);return publicSession(s);}
        if(s.version!==input.expectedVersion)fail('VERSION_CONFLICT',409);
        s.teacherComments.push({ref:randomUUID(),requestId:input.requestId,expectedVersion:input.expectedVersion,section:input.section,feedback:input.feedback.trim(),authorEmail:actor.email,authorName:actor.displayName,createdAt:new Date(clock()).toISOString(),snapshot:Object.fromEntries(FIELDS[input.section].map(f=>[f,s.responses[f]]))});
        return publicSession(s);
      });
    }
  };
}
