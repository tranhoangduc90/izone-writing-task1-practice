// Nhận đầu ra AI nguyên dạng; chỉ bỏ dấu bao markdown khi chúng bao trọn JSON.
// Không sửa nội dung/nuốt lỗi JSON; object sai hoặc sai operationKey vẫn là lỗi kỹ thuật.
export function parseAiResult(raw,operationKey){
  const fenced=raw.trim().match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  const value=JSON.parse(fenced?fenced[1]:raw);
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('AI_RESULT_INVALID');
  if(Object.hasOwn(value,'operation_key')){
    if(value.operation_key!==operationKey)throw new Error('AI_OPERATION_MISMATCH');
    return value.result;
  }
  return value;
}

const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const error=(code,status=503)=>Object.assign(new Error(code),{code,status});

// Nhận URL/khóa riêng của Handout67 và job ghim prompt. Chỉ gọi route đã kiểm,
// giữ văn bản trả về kể cả HTTP lỗi; không ghi header hoặc phần suy nghĩ nội bộ.
export function gatewayAdapter({gatewayUrl,gatewayToken},fetcher=fetch){
  if(!gatewayUrl||new URL(gatewayUrl).protocol!=='https:'||typeof gatewayToken!=='string'||gatewayToken.length<32||/[\r\n]/.test(gatewayToken))throw error('AI_CONFIG_INVALID');
  return async job=>{
    let response;
    try{response=await fetcher(gatewayUrl,{method:'POST',redirect:'error',signal:AbortSignal.timeout(180000),headers:{'x-ai-gateway-key':gatewayToken,'Content-Type':'application/json'},body:JSON.stringify({prompt:job.prompt,model_id:'gemini-3.1-pro-preview',thinking_level:'high',operation_key:job.operationKey})});}
    catch(e){throw error(['TimeoutError','AbortError'].includes(e.name)?'AI_TIMEOUT':'AI_CONNECTION_FAILED');}
    let raw='';
    try{
      const chunks=[];let size=0;
      for await(const chunk of response.body){size+=chunk.length;if(size>524288)throw error('AI_RESPONSE_TOO_LARGE');chunks.push(chunk);}
      raw=Buffer.concat(chunks).toString('utf8');
    }catch(e){throw error(e.code==='AI_RESPONSE_TOO_LARGE'?e.code:'AI_RESPONSE_INTERRUPTED');}
    let value;try{value=JSON.parse(raw);}catch{}
    const parts=value?.candidates?.[0]?.content?.parts;
    const outputText=Array.isArray(parts)?parts.filter(p=>p.thought!==true&&typeof p.text==='string').map(p=>p.text).join(''):raw;
    const transportError=!response.ok?'AI_HTTP_'+response.status:value?.gatewayMeta?.operation_key!==job.operationKey?'AI_TRANSPORT_IDENTITY_MISMATCH':!Array.isArray(value?.candidates)||value.candidates.length!==1||!Array.isArray(parts)?'AI_TRANSPORT_INVALID':null;
    // Chỉ giữ body hữu ích đã bỏ thought; văn bản lỗi vẫn được giữ nguyên để tra cứu.
    const responseBody={gatewayMeta:value?.gatewayMeta??null,usageMetadata:value?.usageMetadata??null,modelVersion:value?.modelVersion??null,outputText};
    return {outputText,responseBody,model:value?.modelVersion||value?.gatewayMeta?.model||value?.gatewayMeta?.fallback_model||null,httpStatus:response.status,providerRef:value?.gatewayMeta?.operation_id??null,transportError};
  };
}

// n8n gọi một attempt và chờ biên nhận. Không tự claim/tự phát AI trong vòng nền:
// giới hạn execution của n8n vẫn bao phủ thời gian gọi AI, webapp không có trần riêng.
export function createProcessor({service,callAI,wait=pause,onError=()=>{}}){
  const running=new Map();let closed=false;
  async function commit(action){
    for(let i=0;i<3;i++){
      try{return await action();}catch(e){if(e.status&&e.status<500)throw e;if(i===2)throw e;await wait(i===0?500:1500);}
    }
  }
  async function run(job){
    let response=await service.savedResponse(job);
    if(!response){
      try{response=await callAI(job);}
      catch(e){onError('AI_ATTEMPT_FAILED');return commit(()=>service.complete({...job,error:'TECHNICAL_FAILURE',errorCode:e.code||'AI_REQUEST_FAILED'}));}
    }
    // Giữ phản hồi trong bộ nhớ khi SQL bị gián đoạn; retry ghi, không gọi AI lại.
    const fields=['outputText','responseBody','model','httpStatus','executionRef','providerRef','transportError'];
    const body=Object.fromEntries(fields.map(k=>[k,response[k]]));
    body.executionRef=response.executionRef??job.executionRef??null;
    return commit(()=>service.receive({...job,...body}));
  }
  return {
    async process(input){
      if(closed)throw error('PROCESSOR_CLOSING');
      // Xác thực cả replay đang chạy, không cho tuple sai nhận biên nhận của job khác.
      const job=await service.forProcessing(input);
      const key=input.jobRef+':'+input.attemptRef;
      if(running.has(key))return running.get(key);
      const promise=(async()=>{
        if(job.status!=='leased')return service.job(job.jobRef);
        return run(job);
      })();
      running.set(key,promise);
      try{return await promise;}finally{running.delete(key);}
    },
    close(){closed=true;},running:()=>running.size
  };
}
