// Nhận bộ dò queue và URL webhook cố định; chỉ đánh thức khi còn việc, không gửi bài/token phiên.
// Mất ACK không mất job: lần dò sau gửi lại, consumer claim khóa queue và operationKey ổn định.
export function createWake({hasWork,url,secret,fetcher=fetch,intervalMs=30000,onError=()=>{}}) {
  let busy=false,closed=false;
  async function tick(){
    if(busy||closed)return;
    busy=true;
    try {
      if(await hasWork()) {
        const response=await fetcher(url,{method:'POST',redirect:'error',headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json'},body:JSON.stringify({productId:'handout-writing67'}),signal:AbortSignal.timeout(5000)});
        if(!response.ok)throw new Error('HANDOUT67_WAKE_UNAVAILABLE');
      }
    } catch(error){onError(error);} finally{busy=false;}
  }
  const timer=setInterval(tick,intervalMs);timer.unref();
  return {tick,close(){closed=true;clearInterval(timer);}};
}
