import {createHash,randomUUID} from 'node:crypto';

const fail=(code,status=400)=>{throw Object.assign(new Error(code),{status});};
export const contentHash=value=>createHash('sha256').update(value).digest('hex');
const fields=['idea1','idea2','topicSentence','b1','a1','x1','b2','a2','x2'];
const requestId=v=>typeof v==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(v);

// Gắn lại chỉ khi vị trí còn chính xác hoặc có đúng một đoạn trùng.
// Đoạn bị xóa hoặc xuất hiện nhiều lần trở thành comment của bản cũ, không đoán vị trí.
export function anchorFor(thread,text){
  if(thread.anchor.kind==='field')return {kind:'field',detached:false};
  const {quote,start,end,sourceHash}=thread.anchor;
  if(contentHash(text)===sourceHash&&text.slice(start,end)===quote)return {kind:'quote',start,end,detached:false};
  const locations=[];let from=0;
  while(from<=text.length){const at=text.indexOf(quote,from);if(at<0)break;locations.push(at);from=at+1;}
  return locations.length===1?{kind:'quote',start:locations[0],end:locations[0]+quote.length,detached:false}:{kind:'quote',detached:true};
}
export function publicThreads(s){
  return (s.commentThreads||[]).map(t=>({ref:t.ref,field:t.field,section:t.section,status:t.status,createdAt:t.createdAt,quote:t.anchor.quote||'',originalContent:t.originalContent??t.anchor.quote??'',sourceVersion:t.sourceVersion,anchor:anchorFor(t,s.responses[t.field]||''),messages:t.messages.map(m=>({ref:m.ref,body:m.body,role:m.role,authorName:m.authorName,createdAt:m.createdAt}))}));
}

// Nhận actor do máy chủ xác thực, không lấy role/name từ body.
// Mỗi request có receipt riêng; trao đổi không tăng phiên bản nội dung hoặc chạm job AI.
export function changeThread(s,actor,input,now){
  if(!input||!requestId(input.requestId)||!['create','reply','status'].includes(input.action))fail('COMMENT_INVALID');
  s.commentReceipts||={};s.commentThreads||=[];
  const signature=contentHash(JSON.stringify(input)),key=actor.role+':'+actor.key+':'+input.requestId;
  if(s.commentReceipts[key]){if(s.commentReceipts[key]!==signature)fail('REQUEST_ID_CONFLICT',409);return;}
  let thread;
  if(input.action==='create'){
    if(actor.role!=='teacher')fail('COMMENT_FORBIDDEN',403);
    if(!fields.includes(input.field)||typeof input.body!=='string'||!input.body.trim()||input.body.length>5000)fail('COMMENT_INVALID');
    const text=s.responses[input.field];
    if(typeof text!=='string'||!text.trim())fail('EMPTY_RESPONSE');
    if(input.fieldHash!==contentHash(text))fail('COMMENT_CONTENT_CHANGED',409);
    const section=['idea1','idea2','topicSentence'].includes(input.field)?'topic':input.field;
    let anchor={kind:'field',sourceHash:contentHash(text),quote:''};
    if(input.range!==undefined){
      const r=input.range;
      if(!r||!Number.isSafeInteger(r.start)||!Number.isSafeInteger(r.end)||r.start<0||r.end<=r.start||r.end>text.length||r.end-r.start>2000)fail('COMMENT_RANGE_INVALID');
      anchor={kind:'quote',start:r.start,end:r.end,quote:text.slice(r.start,r.end),sourceHash:contentHash(text)};
    }
    thread={ref:randomUUID(),field:input.field,section,status:'open',sourceVersion:s.version,originalContent:text,createdAt:new Date(now).toISOString(),anchor,messages:[]};
    s.commentThreads.push(thread);
  }else{
    thread=s.commentThreads.find(t=>t.ref===input.threadRef);
    if(!thread)fail('COMMENT_NOT_FOUND',404);
    if(input.action==='status'){
      if(actor.role!=='teacher')fail('COMMENT_FORBIDDEN',403);
      if(!['open','addressed'].includes(input.status))fail('COMMENT_INVALID');
      thread.status=input.status;
      thread.statusChangedBy=actor.name;thread.statusChangedAt=new Date(now).toISOString();
    }else if(typeof input.body!=='string'||!input.body.trim()||input.body.length>5000)fail('COMMENT_INVALID');
  }
  if(input.action!=='status')thread.messages.push({ref:randomUUID(),body:input.body.trim(),role:actor.role,authorName:actor.name,authorKey:actor.key,createdAt:new Date(now).toISOString()});
  s.commentVersion=(s.commentVersion||0)+1;s.commentReceipts[key]=signature;
}
