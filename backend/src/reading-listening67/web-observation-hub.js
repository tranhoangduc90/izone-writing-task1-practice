/**
 * Một nhịp đối soát cho các tab của dịch vụ; chỉ phát trạng thái khi đổi.
 * Kiểm quyền chạy độc lập theo phiên, nên một nguồn chậm không giữ người khác.
 * Kết nối lại luôn nhận snapshot mới; lỗi đọc tạm không giả thành dữ liệu rỗng.
 */
import {randomUUID,createHash} from 'node:crypto';
import {readWebObservations,observationKey,documentKey} from './web-observation-store.js';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function createWebObservationHub({db,clock=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,read=readWebObservations,interval=1500,maxConnections=1000}){
 const epoch=randomUUID(),members=new Set(),runningGuards=new Set();
 let closed=false,timer=null,reading=null,wakePending=false,sequence=0;
 const stats={scans:0,errors:0,emitted:0};
 function schedule(delay=interval){if(closed||!members.size)return;if(reading){if(delay===0)wakePending=true;return;}if(timer){if(delay!==0)return;clearTimer(timer);}timer=setTimer(()=>{timer=null;void scan();},delay);timer?.unref?.();}
 function send(member,event,value){if(closed||member.closed)return;try{member.send(event,value);}catch{member.close();}}
 function error(member,e){
  const status=e.status||503,code=e.code||'STATE_UNAVAILABLE';
  if(member.error!==code){member.error=code;send(member,[401,403,423].includes(status)?'access_revoked':'unavailable',{code,status});}
  member.last=null;member.current=null;if([401,403,423].includes(status))member.close();
 }
 function publish(member,verified){
  if(closed||member.closed)return;
  const current=member.current;
  if(!current)return;
  const session=current.snapshot.sessions.get(member.guard.kind+':'+member.guard.hash);
  if(!session)return error(member,{code:member.guard.kind==='teacher'?'TEACHER_LOGIN_REQUIRED':'WEB_UNAUTHORIZED',status:401});
  try{member.guard.assertCurrent?.(session,verified);member.document?.verify(current.snapshot.documents.get(documentKey(member.document))||[],verified);}catch(e){return error(member,e);}
  const value=current.snapshot.states.get(observationKey(member.scope));
  if(!value)return error(member,{code:'STATE_UNAVAILABLE',status:503});
  if(value.attemptMissing)return error(member,{code:'ATTEMPT_NOT_FOUND',status:404});
  const revision=digest(value);
  if(member.last===revision&&!member.error)return;
  member.last=revision;member.error=null;stats.emitted++;
  send(member,'state',{epoch,sequence:++sequence,revision,...value});
 }
 async function scan(){
  if(closed||reading)return;
  const active=[...members];
  reading=(async()=>{
   try{
    stats.scans++;
    const snapshot=await read(db,{scopes:active.map(m=>m.scope),guards:active.map(m=>m.guard),documents:active.map(m=>m.document).filter(Boolean),now:new Date(clock()).toISOString()});
    if(closed)return;
    const checks=new Map();
    for(const member of active){
     if(member.closed)continue;member.current={snapshot};
     const row=snapshot.sessions.get(member.guard.kind+':'+member.guard.hash);
     if(!row){error(member,{code:member.guard.kind==='teacher'?'TEACHER_LOGIN_REQUIRED':'WEB_UNAUTHORIZED',status:401});continue;}
     if(member.checking)continue;
     const checkKey=member.guard.key;
     if(!checks.has(checkKey))checks.set(checkKey,Promise.resolve().then(()=>member.guard.verify(row)));
     member.checking=true;
     const work=checks.get(checkKey).then(async verified=>{if(!member.closed&&!closed)publish(member,member.document?.prepare?await member.document.prepare(verified):verified);}).catch(e=>error(member,e)).finally(()=>{member.checking=false;runningGuards.delete(work);});
     runningGuards.add(work);
    }
   }catch(e){stats.errors++;for(const member of active)error(member,e);}
  })();
  try{await reading;}finally{reading=null;const delay=wakePending?0:interval;wakePending=false;schedule(delay);}
 }
 return {
  subscribe({scope,guard,document,send:callback}){
   if(closed)throw Object.assign(Error('STATE_CLOSED'),{code:'STATE_UNAVAILABLE',status:503});
   if(members.size>=maxConnections)throw Object.assign(Error('STATE_LIMIT'),{code:'STATE_CONNECTION_LIMIT',status:503});
   if(!scope?.ownerId||!scope.courseId||!scope.code||!scope.version||!guard?.key||!guard.hash||!['student','teacher'].includes(guard.kind)||typeof guard.verify!=='function'||typeof callback!=='function')throw Error('STATE_OBSERVER_INVALID');
   const member={scope:{...scope},guard,document,send:callback,current:null,checking:false,last:null,error:null,closed:false,close(){if(member.closed)return;member.closed=true;members.delete(member);if(!members.size){clearTimer(timer);timer=null;}}};
   members.add(member);schedule(0);return {close:member.close};
  },
  wake(){schedule(0);},
  async readOnce(scope){const snapshot=await read(db,{scopes:[scope],guards:[],documents:[],now:new Date(clock()).toISOString()}),value=snapshot.states.get(observationKey(scope));if(!value)throw Error('STATE_UNAVAILABLE');return {epoch,revision:digest(value),...value};},
  snapshot(){return {epoch,closed,connections:members.size,...stats};},
  async close(){closed=true;clearTimer(timer);for(const member of members){try{member.send('closing',{});}catch{/* A disconnected tab needs no final frame. */}member.close();}await reading;await Promise.all([...runningGuards]);}
 };
}
