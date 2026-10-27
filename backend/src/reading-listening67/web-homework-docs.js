/**
 * Nhận Docs đã xác minh chủ và job của đúng bài; chỉ lập lệnh cho CTA/dòng tự động.
 * Chọn ô bằng cấu trúc bảng và mã bài, giữ chữ/link tay. Google phải khóa revision,
 * đọc lại cùng planner rồi mới công nhận verified; lỗi mơ hồ trả mã để dừng ghi.
 */
import {WebGradingError} from './web-grader.js';

export const HOMEWORK_CTA='NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP READING';
export const HOMEWORK_STATUS='TÌNH TRẠNG NỘP BÀI READING';
export const HOMEWORK_PREFIX='Reading thực chiến (tự động): ';
const LINK='nhấn vào đây';
const fail=code=>{throw new WebGradingError(code,409);};
const allTabs=tabs=>(tabs||[]).flatMap(tab=>[tab,...allTabs(tab.childTabs)]);
const runs=content=>(content||[]).flatMap(e=>e.paragraph?.elements||[]).filter(e=>e.textRun).map(e=>({start:e.startIndex,end:e.startIndex+e.textRun.content.length,text:e.textRun.content,style:e.textRun.textStyle||{}}));
const cellText=cell=>runs(cell?.content).map(r=>r.text).join('').replace(/\n$/,'');
function scan(content,parents=[],found={paragraphs:[],statuses:[]},statusLabel=HOMEWORK_STATUS){
 for(const e of content||[]){
  if(e.paragraph){const rs=runs([e]);found.paragraphs.push({text:rs.map(r=>r.text).join(''),runs:rs,parents});}
  if(!e.table)continue;
  const rows=e.table.tableRows||[];
  for(let i=0;i<rows.length-1;i++)for(let col=0;col<(rows[i].tableCells||[]).length;col++){
   if(cellText(rows[i].tableCells[col]).trim()===statusLabel&&rows[i+1].tableCells?.[col]){
    found.statuses.push({cell:rows[i+1].tableCells[col],parents:[...parents,e]});
   }
  }
  for(const row of rows)for(const cell of row.tableCells||[])scan(cell.content,[...parents,e],found,statusLabel);
 }
 return found;
}
function indexAt(rs,offset){
 let used=0;
 for(const r of rs){if(offset<used+r.text.length)return r.start+offset-used;used+=r.text.length;}
 fail('DOC_STATUS_INVALID');
}
function charsBetween(rs,start,end){
 const chars=[];
 for(const r of rs)for(let i=0;i<r.text.length;i++)if(r.start+i>=start&&r.start+i<end)chars.push({index:r.start+i,style:r.style});
 if(chars.length!==end-start||chars.some((c,i)=>c.index!==start+i))fail('DOC_RANGE_INVALID');
 return chars;
}
function linked(rs,start,end,url){return charsBetween(rs,start,end).every(c=>c.style.link?.url===url);}

// Hai bài Reading có thể cùng tab: CTA phải đứng ngay trước mã, ô trạng thái
// lấy trong bảng gần nhất bao quanh mã. Thiếu ranh giới chắc chắn thì không đoán.
export function locateReading67Homework(document,binding,contract={}){
 if(document.documentId!==binding.document_id||!document.revisionId)fail('DOC_IDENTITY_MISMATCH');
 if(!binding.code)fail('DOC_CODE_MISMATCH');
 const tab=allTabs(document.tabs).find(t=>t.tabProperties?.tabId===binding.tab_id);
 if(!tab)fail('DOC_TAB_NOT_FOUND');
 const found=scan(tab.documentTab?.body?.content,[],{paragraphs:[],statuses:[]},contract.status||HOMEWORK_STATUS),paragraphs=found.paragraphs.filter(p=>p.text.trim());
 const mentions=paragraphs.filter(p=>p.text.includes(binding.code));
 if(mentions.length!==1||mentions[0].text.trim()!==binding.code)fail('DOC_CODE_MISMATCH');
 const ctaLabel=contract.cta||HOMEWORK_CTA;
 const code=mentions[0],at=paragraphs.indexOf(code),cta=paragraphs[at-1];
 if(!cta||cta.text.trim()!==ctaLabel)fail('DOC_CTA_PAIR_INVALID');
 const offset=cta.text.indexOf(ctaLabel),start=indexAt(cta.runs,offset);
 charsBetween(cta.runs,start,start+ctaLabel.length);
 let candidates=[];
 for(const parent of [...code.parents].reverse()){
  // Ô trạng thái phải thuộc chính bảng bao mã, không lấy từ bảng bài bên cạnh.
  const scoped=found.statuses.filter(s=>s.parents.at(-1)===parent);
  if(scoped.length){candidates=scoped;break;}
 }
 if(candidates.length!==1)fail('DOC_STATUS_AMBIGUOUS');
 return {tabId:binding.tab_id,cta:{...cta,start,end:start+ctaLabel.length},cell:candidates[0].cell};
}

export function planReading67HomeworkWrite(document,binding,job,contract={}){
 const scope=locateReading67Homework(document,binding,contract),tabId=scope.tabId;
 if(job.kind==='cta'){
  if(!/^https:\/\//.test(job.payload.url||''))fail('DOC_LINK_INVALID');
  const {cta}=scope,correct=charsBetween(cta.runs,cta.start,cta.end).every(({style})=>{
   const rgb=style.foregroundColor?.color?.rgbColor;
   return style.link?.url===job.payload.url&&style.underline!==true&&rgb?.red===1&&rgb?.green===1&&rgb?.blue===1;
  });
  return {revisionId:document.revisionId,verified:correct,requests:correct?[]:[{updateTextStyle:{range:{startIndex:cta.start,endIndex:cta.end,tabId},textStyle:{link:{url:job.payload.url},underline:false,foregroundColor:{color:{rgbColor:{red:1,green:1,blue:1}}}},fields:'link,underline,foregroundColor'}}]};
 }
 if(job.kind!=='status'||typeof job.payload.text!=='string'||/[\r\n]/.test(job.payload.text))fail('DOC_STATUS_INVALID');
 const rs=runs(scope.cell.content),existing=cellText(scope.cell),prefixLabel=contract.prefix||HOMEWORK_PREFIX,target=prefixLabel+job.payload.text;
 const managed=existing.split('\n').filter(line=>line.startsWith(prefixLabel));
 if(managed.length>1)fail('DOC_STATUS_AMBIGUOUS');
 const old=managed[0];
 if((!old&&binding.last_doc_text)||(old&&old!==prefixLabel+binding.last_doc_text&&old!==target))fail('DOC_MANUAL_CONFLICT');
 const offset=old?existing.indexOf(old):existing.length,start=indexAt(rs,offset);
 const labelOffset=target.indexOf(LINK);
 if(job.payload.link&&(!/^https:\/\//.test(job.payload.link)||labelOffset<0))fail('DOC_LINK_INVALID');
 if(old===target&&(!job.payload.link||linked(rs,start+labelOffset,start+labelOffset+LINK.length,job.payload.link)))return {revisionId:document.revisionId,verified:true,requests:[]};
 const requests=[];
 if(old)requests.push({deleteContentRange:{range:{startIndex:start,endIndex:start+old.length,tabId}}});
 const prefix=!old&&existing?'\n':'',textStart=start+prefix.length;
 requests.push({insertText:{location:{index:start,tabId},text:prefix+target}},
  {updateTextStyle:{range:{startIndex:textStart,endIndex:textStart+target.length,tabId},textStyle:{bold:false,foregroundColor:{color:{rgbColor:{red:0.082,green:0.169,blue:0.306}}},fontSize:{magnitude:11,unit:'PT'}},fields:'link,bold,foregroundColor,fontSize'}});
 if(job.payload.link)requests.push({updateTextStyle:{range:{startIndex:textStart+labelOffset,endIndex:textStart+labelOffset+LINK.length,tabId},textStyle:{link:{url:job.payload.link},underline:true},fields:'link,underline'}});
 return {revisionId:document.revisionId,verified:false,requests};
}

// Adapter nhận token qua auth private. Không nhận documentId hoặc token từ URL public.
export function createReading67GoogleDocs(auth,{fetcher=fetch}={}){
 async function call(documentId,suffix,body){
  const access=await auth.getAccessToken(),token=typeof access==='string'?access:access.token;
  const response=await fetcher('https://docs.googleapis.com/v1/documents/'+encodeURIComponent(documentId)+suffix,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});
  if(!response.ok){const code=[401,403,404].includes(response.status)?'DOC_HTTP_'+response.status:'DOC_RETRY';throw new WebGradingError(code,503);}
  return response.json();
 }
 return {read:id=>call(id,'?includeTabsContent=true'),write:(id,plan)=>call(id,':batchUpdate',{requests:plan.requests,writeControl:{requiredRevisionId:plan.revisionId}})};
}
