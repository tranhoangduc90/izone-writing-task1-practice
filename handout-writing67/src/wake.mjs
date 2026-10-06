// Nhận bộ dò queue và URL webhook cố định; chỉ đánh thức khi còn việc, không gửi bài/token phiên.
// Mất ACK không mất job: lần dò sau gửi lại, consumer claim khóa queue và operationKey ổn định.
export function createWake({hasWork,url,secret,fetcher=fetch,intervalMs=30000,onError=()=>{}}) {
  let busy=false,closed=false;const notified=new Map();
  async function tick(){
    if(busy||closed)return;
    busy=true;
    try {
      const work=await hasWork(),now=Date.now();
      const keys=Array.isArray(work)?work:work?['legacy']:[];
      const current=new Set(keys);for(const key of notified.keys())if(!current.has(key))notified.delete(key);
      // Một tín hiệu/execution cho mỗi job chờ. Không phát một tín hiệu/30s cho cả lớp.
      // ACK bị mất thì lần dò sau thử lại; ACK sớm được giữ10phút để tránh dồn queue n8n.
      await Promise.all(keys.filter(key=>!Array.isArray(work)||(notified.get(key)||0)<=now).map(async key=>{
        try{
          const response=await fetcher(url,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify({productId:'handout-writing67'}),signal:AbortSignal.timeout(5000)});
          if(!response.ok)throw new Error('HANDOUT67_WAKE_UNAVAILABLE');
          if(Array.isArray(work))notified.set(key,now+600000);
        }catch(e){onError(e);}
      }));
    } catch(error){onError(error);} finally{busy=false;}
  }
  const timer=setInterval(tick,intervalMs);timer.unref();
  return {tick,close(){closed=true;clearInterval(timer);}};
}
