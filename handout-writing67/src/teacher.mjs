import {createHmac,randomUUID,timingSafeEqual} from 'node:crypto';
import {fail,lesson4BodyProgress,lesson6Progress,publicTeacherComments,withBodies} from './service.mjs';
import {bodyKey,isTwoQuestionOutline,workflowFor,GUIDED,preparationContext} from './workflow.mjs';
import {isLesson6Outline,lesson6CoverageMissing,LESSON6_STANCES} from './writing-lesson6.mjs';
import {publicThreads,changeThread} from './comments.mjs';
import {dashboardProjection} from './dashboard.mjs';
import {LEGACY_LESSON5} from './lessons.mjs';
import {teacherRole,hasTeacherClass} from './teacher-registry.mjs';

// Nhận danh tính Google đã xác minh và quyền lớp riêng; chỉ đọc/ghi bảng Handout67.
// Token giảng viên có secret riêng. Không trả job/prompt/lease/capability cho dashboard.
export function createTeacher({db,store,roster,registry,secret,verifyGoogleToken,clock=Date.now,lessons={lesson5:LEGACY_LESSON5}}) {
  if(typeof secret!=='string'||secret.length<32)fail('TEACHER_CONFIG_INVALID');
  const sign=value=>createHmac('sha256',secret).update(value).digest('base64url');
  function account(email,sub){
    const found=registry().teachers.filter(t=>t.email===email && typeof t.subject==='string' && t.subject.length>0 && t.subject===sub);
    if(found.length!==1)fail('TEACHER_FORBIDDEN',403);
    return {...found[0],subject:sub,role:teacherRole(found[0])};
  }
  const publicActor=a=>({displayName:a.displayName,email:a.email,classes:a.classes,role:teacherRole(a),canAccessAllClasses:teacherRole(a)==='admin'});
  const lessonFor=activity=>{if(!Object.hasOwn(lessons,activity))fail('LESSON_NOT_FOUND',404);return lessons[activity];};
  async function context(actor,classRef,activity='lesson5'){
    const lesson=lessonFor(activity);
    if(lesson.classes&&!lesson.classes.includes(classRef))fail('TEACHER_FORBIDDEN',403);
    if(!hasTeacherClass(actor,classRef,activity))fail('TEACHER_FORBIDDEN',403);
    const row=(await roster(activity,lesson.rosterScope)).find(c=>c.classRef===classRef);
    if(!row)fail('CLASS_NOT_OPEN',404);
    return row;
  }
  async function authorizedSession(actor,ref,matches=()=>true){
    const s=await store.read(ref);if(!s)fail('SESSION_NOT_FOUND',404);
    if(!matches(s))fail('SESSION_NOT_FOUND',404);
    const row=await context(actor,s.classRef,s.activity);
    const student=row.students.find(x=>x.studentRef===s.studentRef);
    if(!student)fail('TEACHER_FORBIDDEN',403);
    return {s,student};
  }
  const sessionFor=async(actor,ref)=>(await authorizedSession(actor,ref)).s;
  const publicSession=s=>withBodies({ref:s.ref,activity:s.activity,...(s.outlineOnly?{outlineOnly:true}:{}),...(s.handoutMode?{handoutMode:s.handoutMode,bodyProgress:s.bodyProgress,...(s.preparationMode?{preparationMode:s.preparationMode,...preparationContext(s)}:{})}:{}),workflowMode:s.workflowMode||GUIDED,workflowVersion:s.workflowVersion||1,body:s.body||2,classRef:s.classRef,studentRef:s.studentRef,version:s.version,responses:s.responses,steps:s.steps,vocabulary:s.vocabulary,idea2Open:s.idea2Open,teacherComments:publicTeacherComments(s),commentThreads:publicThreads(s),commentVersion:s.commentVersion||0,...(s.lesson5IdeaSource?{lesson5IdeaSource:s.lesson5IdeaSource}:{}),dashboard:dashboardProjection(s,clock()),processing:dashboardProjection(s,clock()).processing});
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
    // Quyền vẫn đọc registry Handout hiện hành sau khi phiên chung xác minh danh tính.
    fromVerifiedIdentity(p){if(!p?.sub||p.emailVerified!==true||typeof p.email!=='string')fail('TEACHER_UNAUTHORIZED',401);return account(p.email.toLowerCase(),p.sub);},
    async classes(actor,activity='lesson5'){const lesson=lessonFor(activity);return (await roster(activity,lesson.rosterScope)).filter(c=>hasTeacherClass(actor,c.classRef,activity)&&(!lesson.classes||lesson.classes.includes(c.classRef))).map(c=>({classRef:c.classRef,className:c.className,studentCount:c.students.length}));},
    async summary(actor,classRef,activity='lesson5'){
      const row=await context(actor,classRef,activity);
      const result=await db.query("SELECT payload,updated_at FROM handout67.session WHERE payload->>'classRef'=$1 AND payload->>'activity'=$2",[classRef,activity]);
      const sessions=new Map(result.rows.map(r=>[r.payload.studentRef,r]));
      return {activity,classRef,className:row.className,students:row.students.map(student=>{
        const r=sessions.get(student.studentRef),s=r?.payload;
        return {...student,sessionRef:s?.ref||null,updatedAt:r?.updated_at||null,passed:s?workflowFor(s).order.filter(k=>s.steps[k].status==='passed').length:0,steps:s?Object.fromEntries(workflowFor(s).order.map(k=>[k,s.steps[k].status])):{},comments:s?(s.teacherComments||[]).length+(s.commentThreads||[]).length:0,dashboard:s?dashboardProjection(s,clock()):null};
      })};
    },
    async detail(actor,ref){return publicSession(await sessionFor(actor,ref));},
    async homeworkOutline(actor,ref,activity){
      const lesson6=activity==='lesson6';
      const {s,student}=await authorizedSession(actor,ref,s=>lesson6
        ? isLesson6Outline(s)&&/^hw-k67-writing-lesson6-\d+$/.test(s.writingEntry?.assignmentId||'')&&
          Number.isSafeInteger(s.writingEntry.contentVersion)&&s.writingEntry.contentVersion>0
        : isTwoQuestionOutline(s)&&Boolean(s.writingEntry));
      const progress=lesson6?lesson6Progress(s,lessonFor(activity).sharePolicy):null;
      if(lesson6&&!progress.accepted)fail('SESSION_NOT_FOUND',404);
      const bodies=(progress?.bodies||[1,2].map(body=>lesson4BodyProgress(s,body))).map(({body,passed,status})=>{
        const result=s.steps[bodyKey(body,'topic')]?.history?.at(-1);
        const fields=Object.fromEntries(['topicSentence','idea1','idea2'].map(key=>[key,s.responses[bodyKey(body,key)]||'']));
        const feedbackMatches=result&&Object.entries(fields).every(([key,value])=>(result.snapshot?.[bodyKey(body,key)]||'')===value);
        return {body,passed,status,fields,
          feedback:feedbackMatches?result.feedback||'':'',
          feedbackFromEarlierVersion:Boolean(result?.feedback&&!feedbackMatches)};
      });
      return {ref:s.ref,classRef:s.classRef,displayName:student.displayName,passed:bodies.filter(body=>body.passed).length,bodies,
        ...(lesson6?{activity,stance:Object.hasOwn(LESSON6_STANCES,s.responses.stance)?s.responses.stance:null,
          completed:progress.completed,relation:progress.relation,
          missingDimensions:progress.relation==='coverage'?lesson6CoverageMissing([s.steps.body1_topic,s.steps.body2_topic]):[]}:{} )};
    },
    // Quyền lớp/roster lấy lại từ backend; không lấy học viên/lớp hoặc quyền từ query client.
    async activity(actor,ref,query={}){await sessionFor(actor,ref);return store.audit.read(ref,query);},
    async thread(actor,ref,input){
      if(input?.expectedActor!==actor.email)fail('TEACHER_IDENTITY_CHANGED',401);
      await sessionFor(actor,ref);
      return store.edit(ref,s=>{
        if(!hasTeacherClass(actor,s.classRef,s.activity))fail('TEACHER_FORBIDDEN',403);
        changeThread(s,{role:'teacher',key:actor.email,name:actor.displayName},input,clock());
        return publicSession(s);
      });
    },
    async comment(actor,ref,input){
      if(input?.expectedActor!==actor.email)fail('TEACHER_IDENTITY_CHANGED',401);
      if(!input || !Number.isSafeInteger(input.expectedVersion)||typeof input.section!=='string'||typeof input.feedback!=='string'||!input.feedback.trim()||input.feedback.length>4000||typeof input.requestId!=='string'||!/^[a-zA-Z0-9_-]{1,128}$/.test(input.requestId))fail('TEACHER_COMMENT_INVALID');
      await sessionFor(actor,ref);
      return store.edit(ref,s=>{
        // Đọc lại định danh trong transaction; không lấy studentRef/classRef từ body ghi nhận xét.
        if(!hasTeacherClass(actor,s.classRef,s.activity))fail('TEACHER_FORBIDDEN',403);
        if(!workflowFor(s).order.includes(input.section))fail('TEACHER_COMMENT_INVALID');
        s.teacherComments ||= [];
        const previous=s.teacherComments.find(c=>c.requestId===input.requestId&&c.authorEmail===actor.email);
        if(previous){if(previous.section!==input.section||previous.feedback!==input.feedback.trim()||previous.expectedVersion!==input.expectedVersion)fail('REQUEST_ID_CONFLICT',409);return publicSession(s);}
        if(s.version!==input.expectedVersion)fail('VERSION_CONFLICT',409);
        s.teacherComments.push({ref:randomUUID(),requestId:input.requestId,expectedVersion:input.expectedVersion,section:input.section,feedback:input.feedback.trim(),authorEmail:actor.email,authorName:actor.displayName,createdAt:new Date(clock()).toISOString(),snapshot:Object.fromEntries(workflowFor(s).fields[input.section].map(f=>[f,s.responses[f]]))});
        return publicSession(s);
      });
    }
  };
}
