/**
 * Gửi tín hiệu sau khi lưu và nghe một kênh cho cả dịch vụ, không mang bài làm.
 * Tín hiệu chỉ giúp nhận việc sớm: mất mạng thì bộ quét bù vẫn chạy như cũ.
 * Lỗi gửi/nghe được ghi trạng thái riêng, không đổi xác nhận lưu thành thất bại.
 */
import {randomUUID} from 'node:crypto';
const channel='reading67_work_v1',allowed=new Set(['grading','docs','practice']);

export function createWebWorkSignals({query,createClient,onWake,onError=()=>{},setTimer=setTimeout,clearTimer=clearTimeout}){
  const sender=randomUUID(),pending=new Set(),disposals=new WeakMap(),disposing=new Set();
  let closed=false,client=null,connecting=null,retryTimer=null,publishTimer=null,publishing=null,failures=0;
  const stats={connected:false,connections:0,sent:0,received:0,errors:0};
  function report(error){stats.errors++;try{onError(error);}catch{/* Logging cannot break saves or fallback scans. */}}
  function wake(lane){try{onWake(lane);}catch(error){report(error);}}
  function timer(fn,delay){const result=setTimer(fn,delay);result?.unref?.();return result;}
  function retry(){
    if(closed||retryTimer)return;
    retryTimer=timer(()=>{retryTimer=null;void connect();},Math.min(5000,250*2**Math.min(5,failures++)));
  }
  function detach(value){value.removeListener('error',value.workError);value.removeListener('end',value.workEnd);value.removeListener('notification',value.workNotification);}
  function discard(value){
    if(!disposals.has(value)){
      const ended=(async()=>{try{await value.end();}catch{/* The socket may already be gone. */}finally{detach(value);}})();
      disposals.set(value,ended);disposing.add(ended);void ended.finally(()=>disposing.delete(ended));
    }
    return disposals.get(value);
  }
  function lost(value,error){
    if(client!==value)return;
    client=null;stats.connected=false;if(error)report(error);
    void discard(value);retry();
  }
  async function connect(){
    if(closed||client||connecting)return;
    connecting=(async()=>{
      let value;
      try{value=createClient();}catch(error){report(error);retry();return;}
      client=value;
      value.workError=error=>lost(value,error);value.workEnd=()=>lost(value);
      value.workNotification=message=>{
        if(closed||client!==value||message.channel!==channel)return;
        let payload;try{payload=JSON.parse(message.payload);}catch{return;}
        if(payload?.v!==1||typeof payload.sender!=='string'||payload.sender===sender||!Array.isArray(payload.lanes)||!payload.lanes.length||payload.lanes.length>allowed.size||payload.lanes.some(lane=>!allowed.has(lane)))return;
        stats.received++;for(const lane of new Set(payload.lanes))wake(lane);
      };
      value.on('error',value.workError);value.on('end',value.workEnd);value.on('notification',value.workNotification);
      try{
        await value.connect();
        if(closed||client!==value){await discard(value);return;}
        await value.query('LISTEN '+channel);
        if(closed||client!==value){await discard(value);return;}
        stats.connected=true;stats.connections++;failures=0;
        // LISTEN never replays missed notifications; a fresh shared scan reconciles them.
        wake();
      }catch(error){lost(value,error);}
    })();
    try{await connecting;}finally{connecting=null;if(!closed&&!client)retry();}
  }
  function schedulePublish(){if(!closed&&!publishTimer&&!publishing&&pending.size)publishTimer=timer(()=>{publishTimer=null;void flush();},0);}
  async function flush(){
    if(closed||publishing||!pending.size)return;
    const lanes=[...pending];pending.clear();
    publishing=Promise.resolve().then(()=>query('SELECT pg_notify($1,$2)',[channel,JSON.stringify({v:1,sender,lanes})])).then(()=>{stats.sent++;}).catch(report);
    try{await publishing;}finally{publishing=null;schedulePublish();}
  }
  void connect();
  return {
    publish(lane){if(closed)return;if(!allowed.has(lane))throw Error('WORK_LANE_INVALID');wake(lane);pending.add(lane);schedulePublish();},
    snapshot(){return {...stats,closed,pending:pending.size};},
    async close(){if(closed)return;closed=true;clearTimer(retryTimer);clearTimer(publishTimer);pending.clear();await connecting;const value=client;client=null;stats.connected=false;if(value)await discard(value);await Promise.all([...disposing]);await publishing;}
  };
}
