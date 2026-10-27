/** Kiểm mã trên mọi bản Docs vừa đọc, gồm snapshot worker dùng để lập lệnh và đọc lại. */
import {WebGradingError} from './web-grader.js';
export function guardReading67HomeworkDocs(docs,managedCodes=[]){
 const codes=Object.freeze([...new Set(managedCodes)]);
 if(codes.length<2)return docs;
 function texts(content){return (content||[]).flatMap(e=>[(e.paragraph?.elements||[]).map(r=>r.textRun?.content||'').join(''),...(e.table?.tableRows||[]).flatMap(r=>(r.tableCells||[]).flatMap(c=>texts(c.content)))]);}
 function tabs(items){return (items||[]).flatMap(t=>[...texts(t.documentTab?.body?.content),...tabs(t.childTabs)]);}
 return {...docs,async read(id){
  const document=await docs.read(id),body=tabs(document.tabs).join('\n');
  if(codes.filter(code=>body.includes(code)).length>1)throw new WebGradingError('DOC_CODE_MISMATCH',409);
  return document;
 }};
}
