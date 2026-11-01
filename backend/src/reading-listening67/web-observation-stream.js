/** Mở stream bằng phiên đã kiểm; giới hạn bộ đệm và dọn tab ngắt kết nối. */
export function openWebObservationStream({request,response,hub,scope,guard,document}){
 if(response.destroyed||response.writableEnded)return {close(){}};
 let handle,heartbeat,lifetime,ended=false;
 function close(){if(ended)return;ended=true;clearInterval(heartbeat);clearTimeout(lifetime);handle?.close();response.removeListener('close',close);if(!response.writableEnded)response.end();}
 handle=hub.subscribe({scope,guard,document,send(event,value){
  if(ended||response.destroyed)return close();
  if(event==='closing')return close();
  if(response.writableLength>65536)return close();
  const id=event==='state'?`id: ${value.epoch}:${value.sequence}\n`:'';
  if(!response.write(`${id}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`))return close();
  if(event==='access_revoked')close();
 }});
 response.on('close',close);
 try{response.set({'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-store','X-Accel-Buffering':'no'});response.flushHeaders();}catch(error){close();throw error;}
 heartbeat=setInterval(()=>{if(ended||response.destroyed)return close();if(!response.write(': keepalive\n\n'))close();},15000);heartbeat.unref?.();
 // Re-authenticate through the normal HTTP middleware, including teacher cookie renewal.
 lifetime=setTimeout(close,60000);lifetime.unref?.();
 return {close};
}
