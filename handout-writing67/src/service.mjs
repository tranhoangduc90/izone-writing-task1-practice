import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import {parseAiResult} from './processor.mjs';
import {publicThreads, changeThread} from './comments.mjs';
import {LEGACY_LESSON5,publicLesson} from './lessons.mjs';

export const PRODUCT = 'handout-writing67';
export const ORDER = ['topic','b1','a1','x1','b2','a2','x2'];
export const FIELDS = {topic:['idea1','idea2','topicSentence'],b1:['b1'],a1:['a1'],x1:['x1'],b2:['b2'],a2:['a2'],x2:['x2']};
export const TOPIC = LEGACY_LESSON5.topic;
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function fail(code, status=400) { throw Object.assign(new Error(code), {status}); }
const string = value => typeof value==='string' && value.trim().length>0 && value.length<=4000;
const id = value => typeof value==='string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const object = value => value!==null && typeof value==='object' && !Array.isArray(value);
export const publicTeacherComments = s => (s.teacherComments||[]).map(c=>({ref:c.ref,section:c.section,feedback:c.feedback,authorName:c.authorName,createdAt:c.createdAt,snapshot:c.snapshot}));
const passed = (s,key) => s.steps[key].status==='passed';
const ideaPassed = (s,n) => ['b','a','x'].every(k=>passed(s,k+n));
const available = (s,key) => ORDER.includes(key) && (key==='topic' || passed(s,ORDER[ORDER.indexOf(key)-1])) && (!key.endsWith('2') || s.idea2Open);

// Chỉ đối chiếu những trường thật sự được prompt dùng; snapshot đầy đủ vẫn giữ cho audit.
export function dependencies(section,ideaIndex){
  if(!section)return ['a','x','b'].map(k=>k+ideaIndex);
  if(section==='topic')return FIELDS.topic;
  return [...new Set([section,'idea'+ideaIndex,'topicSentence',...(section[0]==='x'?['a'+ideaIndex]:[]),...(['a','x'].includes(section[0])?['b'+ideaIndex]:[]),...(section==='b2'?['b1']:[])])];
}
const relevant = (job,responses) => hash(Object.fromEntries(dependencies(job.section,job.ideaIndex).map(k=>[k,responses[k]])));

export function createService({store, roster, secret, clock=Date.now, leaseMs=300000, sessionMs=43200000, maxLeases=null, maxJobMs=1800000, retryDelays=[0,0,0], renderJob, promptVersion='lesson5-rubric-v3',lessons={lesson5:{...LEGACY_LESSON5,promptVersion}}}) {
  if (typeof secret!=='string' || secret.length<32 || leaseMs<=180000) fail('CONFIG_INVALID');
  if(maxLeases!==null&&(!Number.isSafeInteger(maxLeases)||maxLeases<1))fail('CONFIG_INVALID');
  if(!Number.isSafeInteger(maxJobMs)||maxJobMs<leaseMs*3||retryDelays.length!==3||retryDelays.some(v=>!Number.isSafeInteger(v)||v<0))fail('CONFIG_INVALID');
  const sign = value => createHmac('sha256',secret).update(value).digest('base64url');
  const lessonFor=activity=>{if(!Object.hasOwn(lessons,activity))fail('LESSON_NOT_FOUND',404);return lessons[activity];};
  const versionAvailable=j=>j.promptVersion===lessonFor(j.snapshot?.activity||'lesson5').promptVersion;
  const publicSession = s => {
    // Lấy job cuối của từng bước/ý trước khi lọc, không hiện lỗi cũ sau lượt mới đã đạt.
    const latest=Object.fromEntries(s.jobs.map(j=>[j.kind==='grade'?j.section:'vocab'+j.ideaIndex,j]));
    const processing=Object.fromEntries(Object.entries(latest).filter(([,j])=>['queued','leased','failed'].includes(j.status)).map(([key,j])=>[key,{jobRef:j.jobRef,status:j.status,tries:j.tries,maxTries:3,createdAt:j.createdAt,deadlineAt:j.deadlineAt??j.createdAt+maxJobMs,leaseUntil:j.leaseUntil,nextAttemptAt:j.nextAttemptAt??null,error:j.error??null}]));
    return {ref:s.ref,activity:s.activity,classRef:s.classRef,studentRef:s.studentRef,responses:s.responses,version:s.version,idea2Open:s.idea2Open,steps:s.steps,vocabulary:s.vocabulary,teacherComments:publicTeacherComments(s),commentThreads:publicThreads(s),commentVersion:s.commentVersion||0,submittedSections:[...new Set(s.jobs.filter(j=>j.kind==='grade').map(j=>j.section))],processing};
  };
  const issue = ref => {const content=`${ref}.${clock()+sessionMs}`;return `${content}.${sign(content)}`;};
  const authorize = (ref,token) => {
    if (typeof token!=='string') fail('SESSION_UNAUTHORIZED',401);
    const [owner,expiry,sig,...extra] = token.split('.');
    const expected = sign(`${owner}.${expiry}`);
    if (extra.length || owner!==ref || !/^\d+$/.test(expiry||'') || Number(expiry)<=clock() || typeof sig!=='string' || Buffer.byteLength(sig)!==Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(sig),Buffer.from(expected))) fail('SESSION_UNAUTHORIZED',401);
  };
  const edit = async (ref, token, change) => {
    authorize(ref,token);
    const result = await store.edit(ref, change);
    if (!result) fail('SESSION_NOT_FOUND',404);
    return result;
  };
  function makeJob(s,kind,section,ideaIndex) {
    const lesson=lessonFor(s.activity),promptVersion=lesson.promptVersion;
    const snapshot = {activity:s.activity,topic:lesson.topic,responses:structuredClone(s.responses),history:section?s.steps[section].history.map(h=>({feedback:h.feedback,status:h.status,snapshot:h.snapshot})):[],ideaIndex};
    const job = {productId:PRODUCT,sessionRef:s.ref,jobRef:randomUUID(),kind,section,ideaIndex,snapshotHash:hash(snapshot),snapshot,promptVersion,status:'queued',tries:0,createdAt:clock(),deadlineAt:clock()+maxJobMs,leaseUntil:0,leaseToken:null,attempts:[]};
    job.operationKey = `${PRODUCT}:${job.jobRef}:${job.promptVersion}`;
    job.inputHash=relevant(job,s.responses);
    // Ghim nguyên prompt vào job trước ACK; retry/redeploy giữ cùng payload và operationKey.
    if(renderJob)job.prompt=renderJob({...envelope(job),snapshot});
    s.jobs.push(job);
    return job;
  }
  function supersede(s,j,reason){
    if(!['queued','leased'].includes(j.status))return;
    j.status='superseded';j.error=null;j.supersededReason=reason;j.supersededAt=clock();
    if(j.kind==='grade'&&s.steps[j.section].status==='pending'){s.steps[j.section].status='revision';s.steps[j.section].error=null;}
  }
  function vocabulary(s,n,delay=0){
    if(!ideaPassed(s,n))return;
    const latest=s.jobs.find(j=>j.jobRef===s.vocabulary[n]?.jobRef);
    const current=hash(Object.fromEntries(['a','x','b'].map(k=>[k+n,s.responses[k+n]])));
    if(latest&&latest.inputHash===current&&['queued','leased','completed'].includes(latest.status))return;
    for(const j of s.jobs)if(j.kind==='vocab'&&j.ideaIndex===n)supersede(s,j,'content_changed');
    const v=makeJob(s,'vocab',null,n);
    // Một khoảng ngắn gộp các lần Edit liên tiếp trước khi phát AI.
    v.nextAttemptAt=clock()+delay;
    s.vocabulary[n]={status:'queued',jobRef:v.jobRef};
  }
  function pass(s,section,source){
    const step=s.steps[section];step.status='passed';step.error=null;
    step.approval={source,at:new Date(clock()).toISOString()};
    if(section[0]==='x')vocabulary(s,Number(section.at(-1)));
  }
  function receipt(s,input,change){
    s.operations||={};const signature=hash(input);
    if(s.operations[input.requestId]){if(s.operations[input.requestId].hash!==signature)fail('REQUEST_ID_CONFLICT',409);return publicSession(s);}
    if(s.version!==input.baseVersion)fail('VERSION_CONFLICT',409);
    change();s.operations[input.requestId]={hash:signature,at:clock(),action:input.field?'edit':'attest',field:input.field??null,section:input.section??null};
    if(Object.keys(s.operations).length>200)delete s.operations[Object.keys(s.operations)[0]];
    return publicSession(s);
  }
  function resultValid(job,result) {
    if (!object(result)) return false;
    if (job.kind==='grade') return ['passed','needs_revision'].includes(result.resultStatus) && string(result.feedback) && result.feedback.trim().split(/\s+/).length<=150 && Object.keys(result).every(k=>['resultStatus','feedback'].includes(k));
    if (Object.keys(result).sort().join(',')!=='A,B,X') return false;
    return ['A','X','B'].every(k=>Array.isArray(result[k]) && result[k].length===2 && result[k].every(v=>object(v) && Object.keys(v).sort().join(',')==='meaningVi,phrase' && string(v.phrase) && v.phrase.trim().split(/\s+/).length<=5 && string(v.meaningVi)));
  }
  function envelope(job) {
    return Object.fromEntries(['productId','sessionRef','jobRef','kind','section','ideaIndex','snapshotHash','promptVersion','operationKey','leaseToken','attemptRef'].map(k=>[k,job[k]]));
  }
  function sameEnvelope(job,body) {return Object.entries(envelope(job)).every(([key,value])=>body[key]===value);}
  function terminalFailure(s,j,error){
    j.status='failed';j.error=error;
    if(j.kind==='grade'){s.steps[j.section].status='technical_error';s.steps[j.section].error=error;}
    else s.vocabulary[j.ideaIndex]={status:'failed',jobRef:j.jobRef,error};
  }
  function expire(s){
    for(const j of s.jobs){
      if(!['queued','leased'].includes(j.status))continue;
      if(clock()>=(j.deadlineAt??j.createdAt+maxJobMs)){terminalFailure(s,j,'JOB_WAIT_EXHAUSTED');continue;}
      if(j.status==='leased'&&j.leaseUntil<=clock()){
        if(j.tries>=3)terminalFailure(s,j,'TECHNICAL_RETRIES_EXHAUSTED');
        else {j.status='queued';j.error='ATTEMPT_TIMEOUT';j.nextAttemptAt=clock()+retryDelays[j.tries];}
      }
    }
  }
  const api = {
    authorizeSession(ref,token) {authorize(ref,token);},
    lesson(activity='lesson5'){return publicLesson(lessonFor(activity));},
    async roster(activity='lesson5') {const lesson=lessonFor(activity);return (await roster()).filter(c=>!lesson.classes||lesson.classes.includes(c.classRef));},
    async open(input) {
      if (!object(input) || !id(input.activity) || !id(input.classRef) || !id(input.studentRef)) fail('IDENTITY_INVALID');
      const rows=await api.roster(input.activity);
      if (!rows.some(c=>c.classRef===input.classRef && c.students.some(s=>s.studentRef===input.studentRef))) fail('STUDENT_OUT_OF_SCOPE',403);
      const key=JSON.stringify([input.activity,input.classRef,input.studentRef]);
      const s=await store.open(key,ref=>({ref,activity:input.activity,classRef:input.classRef,studentRef:input.studentRef,responses:Object.fromEntries(Object.values(FIELDS).flat().map(k=>[k,''])),version:0,idea2Open:false,steps:Object.fromEntries(ORDER.map(k=>[k,{status:'draft',history:[],error:null}])),jobs:[],vocabulary:{},saves:{}}));
      return {session:publicSession(s),token:issue(s.ref)};
    },
    async read(ref,token) {
      authorize(ref,token);const s=await store.read(ref);if(!s)fail('SESSION_NOT_FOUND',404);
      if(s.jobs.some(j=>['queued','leased'].includes(j.status)&&(clock()>=(j.deadlineAt??j.createdAt+maxJobMs)||(j.status==='leased'&&j.leaseUntil<=clock()))))return edit(ref,token,current=>{expire(current);return publicSession(current);});
      return publicSession(s);
    },
    async save(ref,token,input) {
      if (!object(input) || !Number.isSafeInteger(input.baseVersion) || !id(input.requestId) || !object(input.responses)) fail('SAVE_INVALID');
      return edit(ref,token,s=>{
        const signature=hash(input);
        if(s.saves[input.requestId]) {if(s.saves[input.requestId]!==signature)fail('REQUEST_ID_CONFLICT',409);return publicSession(s);}
        if(s.version!==input.baseVersion)fail('VERSION_CONFLICT',409);
        for(const [field,value] of Object.entries(input.responses)) {
          const section=ORDER.find(k=>FIELDS[k].includes(field));
          if(!section || typeof value!=='string' || value.length>4000)fail('FIELD_INVALID');
          if(value!==s.responses[field] && (!available(s,section) || ['pending','passed'].includes(s.steps[section].status)))fail('FIELD_LOCKED',409);
          s.responses[field]=value;
        }
        s.version++;
        s.saves[input.requestId]=signature;
        // Giữ tối đa 200 biên nhận lưu gần nhất; version vẫn chặn replay cũ bị loại.
        if(Object.keys(s.saves).length>200)delete s.saves[Object.keys(s.saves)[0]];
        return publicSession(s);
      });
    },
    async check(ref,token,input) {
      if(!object(input) || !ORDER.includes(input.section) || !id(input.requestId) || !Number.isSafeInteger(input.baseVersion))fail('CHECK_INVALID');
      return edit(ref,token,s=>{
        expire(s);
        const prior=s.jobs.find(j=>j.requestId===input.requestId);
        if(prior) {if(prior.section!==input.section || prior.requestHash!==hash(input))fail('REQUEST_ID_CONFLICT',409);return {jobRef:prior.jobRef,session:publicSession(s)};}
        if(s.version!==input.baseVersion)fail('VERSION_CONFLICT',409);
        if(!available(s,input.section) || ['passed','pending'].includes(s.steps[input.section].status))fail('STEP_LOCKED',409);
        if(FIELDS[input.section].some(k=>!string(s.responses[k])))fail('EMPTY_RESPONSE');
        const n=input.section==='topic'?null:Number(input.section.at(-1));
        const job=makeJob(s,'grade',input.section,n);
        job.requestId=input.requestId;job.requestHash=hash(input);
        s.steps[input.section].status='pending';s.steps[input.section].error=null;
        return {jobRef:job.jobRef,session:publicSession(s)};
      });
    },
    async attest(ref,token,input){
      if(!object(input)||!id(input.requestId)||!Number.isSafeInteger(input.baseVersion)||!ORDER.includes(input.section)||input.teacherPermission!==true)fail('ATTEST_INVALID');
      return edit(ref,token,s=>receipt(s,input,()=>{
        if(!available(s,input.section)||passed(s,input.section))fail('STEP_LOCKED',409);
        if(!s.jobs.some(j=>j.kind==='grade'&&j.section===input.section))fail('CHECK_REQUIRED',409);
        if(FIELDS[input.section].some(k=>!string(s.responses[k])))fail('EMPTY_RESPONSE');
        for(const j of s.jobs)if(j.kind==='grade'&&j.section===input.section)supersede(s,j,'student_attested_teacher_permission');
        pass(s,input.section,'student_attested_teacher_permission');
      }));
    },
    async revise(ref,token,input){
      const section=ORDER.find(k=>FIELDS[k].includes(input?.field));
      if(!object(input)||!id(input.requestId)||!Number.isSafeInteger(input.baseVersion)||!section||!string(input.value))fail('EDIT_INVALID');
      return edit(ref,token,s=>receipt(s,input,()=>{
        if(!available(s,section))fail('FIELD_LOCKED',409);
        if(s.responses[input.field]===input.value)return;
        s.responses[input.field]=input.value;s.version++;
        s.steps[section].editedAt=new Date(clock()).toISOString();
        if(passed(s,section))s.steps[section].editedAfterApproval=true;
        for(const j of s.jobs)if(dependencies(j.section,j.ideaIndex).includes(input.field))supersede(s,j,'content_changed');
        if(/^[axb][12]$/.test(input.field))vocabulary(s,Number(input.field.at(-1)),1000);
      }));
    },
    async replyComment(ref,token,input){
      return edit(ref,token,s=>{changeThread(s,{role:'student',key:s.studentRef,name:'Học viên'},input,clock());return publicSession(s);});
    },
    async openIdea2(ref,token) {return edit(ref,token,s=>{if(!ideaPassed(s,1))fail('IDEA1_INCOMPLETE',409);s.idea2Open=true;return publicSession(s);});},
    async retryVocabulary(ref,token,n) {return edit(ref,token,s=>{
      if(![1,2].includes(n)||!ideaPassed(s,n))fail('VOCAB_LOCKED',409);
      if(s.vocabulary[n]?.status!=='failed')fail('VOCAB_RETRY_UNAVAILABLE',409);
      const job=makeJob(s,'vocab',null,n);s.vocabulary[n]={status:'queued',jobRef:job.jobRef};return publicSession(s);
    });},
    async claim() {
      return store.queue(sessions=>{
        for(const s of sessions)expire(s);
        const now=clock();
        const active=sessions.flatMap(s=>s.jobs).filter(j=>j.status==='leased'&&j.leaseUntil>now).length;
        // Mặc định không có trần riêng của webapp; n8n nhận một job/execution.
        // maxLeases chỉ dùng khi fixture cần kiểm chính sách quota cũ.
        let capacity=maxLeases===null?Infinity:Math.max(0,maxLeases-active);const claimed=[];
        for(const s of sessions) for(const j of s.jobs) {
          if(!['queued','leased'].includes(j.status) || (j.status==='leased'&&j.leaseUntil>now))continue;
          if((renderJob && !j.prompt && !versionAvailable(j)) || j.tries>=3) {
            j.status='failed';j.error='TECHNICAL_RETRIES_EXHAUSTED';
            if(j.kind==='grade') {s.steps[j.section].status='technical_error';s.steps[j.section].error=j.error;}
            else s.vocabulary[j.ideaIndex]={status:'failed',jobRef:j.jobRef};
            continue;
          }
          if(!capacity || claimed.length>=1||(j.nextAttemptAt||0)>now)continue;
          j.status='leased';j.tries++;j.leaseUntil=now+leaseMs;j.leaseToken=randomUUID();capacity--;
          j.attemptRef=randomUUID();j.attempts||=[];j.attempts.push({number:j.tries,ref:j.attemptRef,leaseHash:hash(j.leaseToken)});
          claimed.push({...envelope(j),snapshot:j.snapshot,leaseUntil:j.leaseUntil,...(j.prompt?{prompt:j.prompt}:{})});
        }
        return claimed.map(job=>renderJob&&!job.prompt?{...job,prompt:renderJob(job)}:job);
      });
    },
    async complete(input) {
      if(!object(input) || !id(input.jobRef) || !id(input.sessionRef))fail('CALLBACK_INVALID');
      const result=await store.edit(input.sessionRef,s=>{
        const j=s.jobs.find(j=>j.jobRef===input.jobRef);if(!j)fail('JOB_NOT_FOUND',404);
        if(!sameEnvelope(j,input))fail('CALLBACK_IDENTITY_MISMATCH',409);
        if(j.status==='superseded')return {jobRef:j.jobRef,status:j.status};
        if(j.status==='completed') {if(j.resultHash!==hash(input.result))fail('CALLBACK_RESULT_CONFLICT',409);return {jobRef:j.jobRef,status:j.status,resultHash:j.resultHash};}
        // Kết quả sau hạn toàn lượt không được mở bước, dù lease cuối còn hiệu lực.
        if(['queued','leased'].includes(j.status)&&(j.deadlineAt??j.createdAt+maxJobMs)<=clock()){
          expire(s);return {jobRef:j.jobRef,status:j.status,error:j.error};
        }
        if(j.status!=='leased'||j.leaseUntil<=clock())fail('LEASE_EXPIRED',409);
        if(input.error==='TECHNICAL_FAILURE') {
          j.status=j.tries<3?'queued':'failed';j.error=id(input.errorCode)?input.errorCode:input.error;
          j.nextAttemptAt=j.status==='queued'?clock()+retryDelays[j.tries]:null;
          if(j.status==='failed') {
            if(j.kind==='grade') {s.steps[j.section].status='technical_error';s.steps[j.section].error=j.error;}
            else s.vocabulary[j.ideaIndex]={status:'failed',jobRef:j.jobRef};
          }
          return {jobRef:j.jobRef,status:j.status};
        }
        if(!resultValid(j,input.result))fail('RESULT_INVALID',422);
        if(j.kind==='grade' && (s.steps[j.section].status!=='pending'||relevant(j,s.responses)!==(j.inputHash??relevant(j,j.snapshot.responses))))fail('SNAPSHOT_STALE',409);
        if(j.kind==='vocab'&&(!ideaPassed(s,j.ideaIndex)||s.vocabulary[j.ideaIndex]?.jobRef!==j.jobRef||relevant(j,s.responses)!==(j.inputHash??relevant(j,j.snapshot.responses))))fail('VOCAB_STALE',409);
        j.status='completed';j.error=null;j.resultHash=hash(input.result);j.result=input.result;
        if(j.kind==='grade') {
          const step=s.steps[j.section];step.status=input.result.resultStatus==='passed'?'passed':'revision';step.error=null;
          step.history.push({number:step.history.length+1,status:step.status,feedback:input.result.feedback,snapshot:Object.fromEntries(FIELDS[j.section].map(k=>[k,j.snapshot.responses[k]])),jobRef:j.jobRef});
          if(step.status==='passed')pass(s,j.section,'ai');
        } else {
          if(!ideaPassed(s,j.ideaIndex)||s.vocabulary[j.ideaIndex]?.jobRef!==j.jobRef)fail('VOCAB_STALE',409);
          s.vocabulary[j.ideaIndex]={status:'ready',jobRef:j.jobRef,sourceHash:j.snapshotHash,groups:input.result};
        }
        // Giữ receipt identity/hash để replay; nội dung đã nằm trong history/vocab của phiên.
        delete j.snapshot;delete j.result;delete j.prompt;
        return {jobRef:j.jobRef,status:j.status,resultHash:j.resultHash};
      });
      if(!result)fail('SESSION_NOT_FOUND',404);
      return result;
    },
    async job(ref) {
      const j=await store.findJob(ref);if(!j)fail('JOB_NOT_FOUND',404);
      return {jobRef:j.jobRef,productId:j.productId,status:j.status,resultHash:j.resultHash??null,tries:j.tries,createdAt:j.createdAt,leaseUntil:j.leaseUntil,error:j.error??null};
    },
    async sweep(){return store.queue(sessions=>{for(const s of sessions)expire(s);return {checked:sessions.length};});},
    async forProcessing(input){
      if(!object(input)||!id(input.jobRef))fail('CALLBACK_INVALID');
      const job=await store.findJob(input.jobRef);if(!job)fail('JOB_NOT_FOUND',404);
      if(!sameEnvelope(job,input))fail('CALLBACK_IDENTITY_MISMATCH',409);
      if(['completed','queued','failed','superseded'].includes(job.status))return job;
      if((job.deadlineAt??job.createdAt+maxJobMs)<=clock()){
        await store.edit(job.sessionRef,s=>{expire(s);});return store.findJob(input.jobRef);
      }
      if(job.status!=='leased'||job.leaseUntil<=clock())fail('LEASE_EXPIRED',409);
      if(!job.prompt&&renderJob&&versionAvailable(job))job.prompt=renderJob({...envelope(job),snapshot:job.snapshot});
      if(typeof job.prompt!=='string'||!job.prompt)fail('PROMPT_MISSING',503);
      return {...job,executionRef:id(input.executionRef)?input.executionRef:null};
    },
    async savedResponse(job){return store.audit.response(job.jobRef,job.attemptRef);},
    async receive(input){
      if(!object(input)||!id(input.jobRef)||!id(input.sessionRef)||typeof input.outputText!=='string')fail('AI_RESPONSE_INVALID');
      const j=await store.findJob(input.jobRef);if(!j)fail('JOB_NOT_FOUND',404);
      for(const key of ['productId','sessionRef','jobRef','kind','section','ideaIndex','snapshotHash','promptVersion','operationKey'])if(input[key]!==j[key])fail('CALLBACK_IDENTITY_MISMATCH',409);
      const attempt=j.attempts?.find(a=>a.ref===input.attemptRef&&a.leaseHash===hash(input.leaseToken));
      if(!attempt)fail('CALLBACK_IDENTITY_MISMATCH',409);
      const captured=await store.audit.capture(j,attempt,input,clock());
      if(j.status==='superseded')return {jobRef:j.jobRef,status:'superseded',...captured};
      if(!sameEnvelope(j,input)||j.status==='failed'||j.leaseUntil<=clock())return {jobRef:j.jobRef,status:'late_response_saved',...captured};
      if(j.status==='queued'&&captured.replayed)return {jobRef:j.jobRef,status:j.status,...captured};
      if(input.transportError)return api.complete({...input,error:'TECHNICAL_FAILURE',errorCode:id(input.transportError)?input.transportError:'AI_TRANSPORT_INVALID'});
      let result;
      try{result=parseAiResult(input.outputText,j.operationKey);}catch(error){
        return api.complete({...input,error:'TECHNICAL_FAILURE',errorCode:error.message==='AI_OPERATION_MISMATCH'?'AI_OPERATION_MISMATCH':'AI_JSON_INVALID'});
      }
      if(!resultValid(j,result))return api.complete({...input,error:'TECHNICAL_FAILURE',errorCode:'AI_RESULT_INVALID'});
      return api.complete({...input,result});
    }
  };
  return api;
}
