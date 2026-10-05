import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

export const PRODUCT = 'handout-writing67';
export const ORDER = ['topic','b1','a1','x1','b2','a2','x2'];
export const FIELDS = {topic:['idea1','idea2','topicSentence'],b1:['b1'],a1:['a1'],x1:['x1'],b2:['b2'],a2:['a2'],x2:['x2']};
export const TOPIC = 'Many people buy products that they do not really need and replace old products with new ones unnecessarily. Why do people buy things they do not need? Do you think this is a good thing?';
export const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function fail(code, status=400) { throw Object.assign(new Error(code), {status}); }
const string = value => typeof value==='string' && value.trim().length>0 && value.length<=4000;
const id = value => typeof value==='string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value);
const object = value => value!==null && typeof value==='object' && !Array.isArray(value);
const passed = (s,key) => s.steps[key].status==='passed';
const ideaPassed = (s,n) => ['b','a','x'].every(k=>passed(s,k+n));
const available = (s,key) => ORDER.includes(key) && (key==='topic' || passed(s,ORDER[ORDER.indexOf(key)-1])) && (!key.endsWith('2') || s.idea2Open);

export function createService({store, roster, secret, clock=Date.now, leaseMs=300000, sessionMs=43200000, maxLeases=2, renderJob, promptVersion='lesson5-rubric-v3'}) {
  if (typeof secret!=='string' || secret.length<32 || leaseMs<=180000) fail('CONFIG_INVALID');
  const sign = value => createHmac('sha256',secret).update(value).digest('base64url');
  const publicSession = s => ({ref:s.ref,activity:s.activity,classRef:s.classRef,studentRef:s.studentRef,responses:s.responses,version:s.version,idea2Open:s.idea2Open,steps:s.steps,vocabulary:s.vocabulary});
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
    const snapshot = {topic:TOPIC,responses:structuredClone(s.responses),history:section?s.steps[section].history.map(h=>({feedback:h.feedback,status:h.status,snapshot:h.snapshot})):[],ideaIndex};
    const job = {productId:PRODUCT,sessionRef:s.ref,jobRef:randomUUID(),kind,section,ideaIndex,snapshotHash:hash(snapshot),snapshot,promptVersion,status:'queued',tries:0,createdAt:clock(),leaseUntil:0,leaseToken:null};
    job.operationKey = `${PRODUCT}:${job.jobRef}:${job.promptVersion}`;
    // Ghim nguyên prompt vào job trước ACK; retry/redeploy giữ cùng payload và operationKey.
    if(renderJob)job.prompt=renderJob({...envelope(job),snapshot});
    s.jobs.push(job);
    return job;
  }
  function resultValid(job,result) {
    if (!object(result)) return false;
    if (job.kind==='grade') return ['passed','needs_revision'].includes(result.resultStatus) && string(result.feedback) && result.feedback.trim().split(/\s+/).length<=150 && Object.keys(result).every(k=>['resultStatus','feedback'].includes(k));
    if (Object.keys(result).sort().join(',')!=='A,B,X') return false;
    return ['A','X','B'].every(k=>Array.isArray(result[k]) && result[k].length===2 && result[k].every(v=>object(v) && Object.keys(v).sort().join(',')==='meaningVi,phrase' && string(v.phrase) && v.phrase.trim().split(/\s+/).length<=5 && string(v.meaningVi)));
  }
  function envelope(job) {
    return Object.fromEntries(['productId','sessionRef','jobRef','kind','section','ideaIndex','snapshotHash','promptVersion','operationKey','leaseToken'].map(k=>[k,job[k]]));
  }
  function sameEnvelope(job,body) {return Object.entries(envelope(job)).every(([key,value])=>body[key]===value);}
  return {
    authorizeSession(ref,token) {authorize(ref,token);},
    async roster() { return roster(); },
    async open(input) {
      if (!object(input) || input.activity!=='lesson5' || !id(input.classRef) || !id(input.studentRef)) fail('IDENTITY_INVALID');
      const rows=await roster();
      if (!rows.some(c=>c.classRef===input.classRef && c.students.some(s=>s.studentRef===input.studentRef))) fail('STUDENT_OUT_OF_SCOPE',403);
      const key=JSON.stringify([input.activity,input.classRef,input.studentRef]);
      const s=await store.open(key,ref=>({ref,activity:input.activity,classRef:input.classRef,studentRef:input.studentRef,responses:Object.fromEntries(Object.values(FIELDS).flat().map(k=>[k,''])),version:0,idea2Open:false,steps:Object.fromEntries(ORDER.map(k=>[k,{status:'draft',history:[],error:null}])),jobs:[],vocabulary:{},saves:{}}));
      return {session:publicSession(s),token:issue(s.ref)};
    },
    async read(ref,token) {authorize(ref,token);const s=await store.read(ref);if(!s)fail('SESSION_NOT_FOUND',404);return publicSession(s);},
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
    async openIdea2(ref,token) {return edit(ref,token,s=>{if(!ideaPassed(s,1))fail('IDEA1_INCOMPLETE',409);s.idea2Open=true;return publicSession(s);});},
    async retryVocabulary(ref,token,n) {return edit(ref,token,s=>{
      if(![1,2].includes(n)||!ideaPassed(s,n))fail('VOCAB_LOCKED',409);
      if(s.vocabulary[n]?.status!=='failed')fail('VOCAB_RETRY_UNAVAILABLE',409);
      const job=makeJob(s,'vocab',null,n);s.vocabulary[n]={status:'queued',jobRef:job.jobRef};return publicSession(s);
    });},
    async claim() {
      return store.queue(sessions=>{
        const now=clock();
        const active=sessions.flatMap(s=>s.jobs).filter(j=>j.status==='leased'&&j.leaseUntil>now).length;
        let capacity=Math.max(0,maxLeases-active);const claimed=[];
        for(const s of sessions) for(const j of s.jobs) {
          if(!['queued','leased'].includes(j.status) || (j.status==='leased'&&j.leaseUntil>now))continue;
          if((renderJob && !j.prompt && j.promptVersion!==promptVersion) || j.tries>=3) {
            j.status='failed';j.error='TECHNICAL_RETRIES_EXHAUSTED';
            if(j.kind==='grade') {s.steps[j.section].status='technical_error';s.steps[j.section].error=j.error;}
            else s.vocabulary[j.ideaIndex]={status:'failed',jobRef:j.jobRef};
            continue;
          }
          if(!capacity || claimed.length>=1)continue;
          j.status='leased';j.tries++;j.leaseUntil=now+leaseMs;j.leaseToken=randomUUID();capacity--;
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
        if(j.status==='completed') {if(j.resultHash!==hash(input.result))fail('CALLBACK_RESULT_CONFLICT',409);return {jobRef:j.jobRef,status:j.status,resultHash:j.resultHash};}
        if(j.status!=='leased'||j.leaseUntil<=clock())fail('LEASE_EXPIRED',409);
        if(input.error==='TECHNICAL_FAILURE') {
          j.status=j.tries<3?'queued':'failed';j.error=input.error;
          if(j.status==='failed') {
            if(j.kind==='grade') {s.steps[j.section].status='technical_error';s.steps[j.section].error=input.error;}
            else s.vocabulary[j.ideaIndex]={status:'failed',jobRef:j.jobRef};
          }
          return {jobRef:j.jobRef,status:j.status};
        }
        if(!resultValid(j,input.result))fail('RESULT_INVALID',422);
        if(j.kind==='grade' && (s.steps[j.section].status!=='pending'||hash({topic:TOPIC,responses:s.responses,history:s.steps[j.section].history.map(h=>({feedback:h.feedback,status:h.status,snapshot:h.snapshot})),ideaIndex:j.ideaIndex})!==j.snapshotHash))fail('SNAPSHOT_STALE',409);
        j.status='completed';j.resultHash=hash(input.result);j.result=input.result;
        if(j.kind==='grade') {
          const step=s.steps[j.section];step.status=input.result.resultStatus==='passed'?'passed':'revision';step.error=null;
          step.history.push({number:step.history.length+1,status:step.status,feedback:input.result.feedback,snapshot:Object.fromEntries(FIELDS[j.section].map(k=>[k,j.snapshot.responses[k]])),jobRef:j.jobRef});
          if(j.section[0]==='x' && step.status==='passed') {const v=makeJob(s,'vocab',null,j.ideaIndex);s.vocabulary[j.ideaIndex]={status:'queued',jobRef:v.jobRef};}
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
    }
  };
}
