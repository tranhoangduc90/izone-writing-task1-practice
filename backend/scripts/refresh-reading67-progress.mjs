// Nhận cấu hình private và đường lưu bằng chứng. Mặc định chỉ xem trước; --apply
// làm mới dòng Docs từ kết quả đã lưu, không tạo/nộp/chấm/reset bài học viên.
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createReading67Postgres} from '../src/reading-listening67/web-postgres.js';
import {createContext} from '../src/reading-listening67/authority/context.js';
import {createReading67OwnerSource} from '../src/reading-listening67/web-owner-source.js';
import {createReading67HomeworkRuntime} from '../src/reading-listening67/web-homework-runtime.js';
import {locateReading67Homework,HOMEWORK_PREFIX,planReading67HomeworkWrite} from '../src/reading-listening67/web-homework-docs.js';
const [configPath,evidenceDir,mode]=process.argv.slice(2),apply=mode==='--apply';
if(!configPath||!path.isAbsolute(evidenceDir||'')||mode&&mode!=='--apply')throw Error('CONFIG_AND_PRIVATE_EVIDENCE_REQUIRED');
const config=JSON.parse(await fs.readFile(configPath,'utf8'));
if(config.mode!=='https_classroom'||config.allowedClassIds.join(',')!=='1293'||config.authority.kind!=='http')throw Error('EXACT_CLASSROOM_SCOPE_REQUIRED');
const content=JSON.parse(await fs.readFile(config.contentPath,'utf8'));
if(content.code!=='67-reading-materials-beyond-concrete-matching-information-nen-cap-1')throw Error('EXACT_ASSIGNMENT_REQUIRED');
const db=createReading67Postgres({connectionString:(await fs.readFile(config.database.connectionFile,'utf8')).trim()});
const context=createContext({url:config.authority.url,key:(await fs.readFile(config.authority.keyFile,'utf8')).trim()});
const ownerSource=createReading67OwnerSource({context,allowedClassIds:config.allowedClassIds,url:config.homework.owner.url,key:(await fs.readFile(config.homework.owner.keyFile,'utf8')).trim()});
const runtime=await createReading67HomeworkRuntime({config:config.homework,db,content,identity:{},ownerSource});
await fs.mkdir(evidenceDir,{recursive:true,mode:0o700});
const proofFile=path.join(evidenceDir,'preview.private.json');
// So chữ và hyperlink ngoài đúng dòng quản lý; chỉ số Google đổi sau chèn chữ
// không được hiểu nhầm thành mất nội dung. Thiếu/trùng dòng thì dừng rõ ràng.
function outsideFingerprint(document,binding,message){
 const selected=locateReading67Homework(document,binding).cell,items=[];
 function paragraphs(content,omit){
  const chars=[];
  for(const element of content||[]){
   if(element.paragraph)for(const run of element.paragraph.elements||[])if(run.textRun)for(const char of run.textRun.content)chars.push([char,run.textRun.textStyle?.link?.url||'']);
   if(element.table){items.push(...chars.splice(0));for(const row of element.table.tableRows||[])for(const cell of row.tableCells||[])paragraphs(cell.content,cell===selected);}
  }
  if(omit){const text=chars.map(c=>c[0]).join(''),target=HOMEWORK_PREFIX+message,at=text.indexOf(target);
   if(at<0||text.indexOf(target,at+target.length)>=0)throw Error('DOC_MANAGED_LINE_CHANGED');
   const start=[...text.slice(0,at)].length;chars.splice(start,[...target].length,['[READING_AUTO_STATUS]','']);
  }
  items.push(...chars);
 }
 function tabs(list){for(const tab of list||[]){if(tab.documentTab)paragraphs(tab.documentTab.body?.content);tabs(tab.childTabs);}}
 tabs(document.tabs);return createHash('sha256').update(JSON.stringify(items)).digest('hex');
}
try{
 if(!apply){
  const bindings=(await db.query('SELECT owner_id,course_id,assignment_code,content_version FROM reading_listening67.web_homework_binding WHERE course_id=$1 AND assignment_code=$2 AND content_version=$3 ORDER BY owner_id',['1293',content.code,content.version])).rows;
  const candidates=[];
  for(const b of bindings){const scope={ownerId:b.owner_id,courseId:b.course_id,code:b.assignment_code,version:b.content_version},proof=await runtime.homework.previewStatus(scope);
   if(!proof?.target||!proof.payload.text.includes('Kết quả:')||proof.previousText===proof.payload.text)continue;
   const document=await runtime.docs.read(proof.target.documentId),binding={document_id:proof.target.documentId,tab_id:proof.target.tabId,code:content.code};
   const fingerprint=outsideFingerprint(document,binding,proof.previousText);
   await fs.writeFile(path.join(evidenceDir,scope.ownerId+'-before.private.json'),JSON.stringify(document),{mode:0o600});
   candidates.push({scope,proof,fingerprint});
  }
  await fs.writeFile(proofFile,JSON.stringify(candidates,null,2),{mode:0o600});console.log(JSON.stringify({outcome:'preview',candidates:candidates.length}));
 }else{
  const candidates=JSON.parse(await fs.readFile(proofFile,'utf8')),results=[];
  for(const item of candidates){
   const {scope,proof}=item;
   if(scope.courseId!=='1293'||scope.code!==content.code||scope.version!==content.version)throw Error('REFRESH_SCOPE_MISMATCH');
   const binding={document_id:proof.target.documentId,tab_id:proof.target.tabId,code:scope.code};
   const current=await runtime.docs.read(binding.document_id);
   if(outsideFingerprint(current,binding,proof.previousText)!==item.fingerprint)throw Error('DOC_CONTENT_CHANGED_AFTER_PREVIEW');
   const job=await runtime.homework.refreshStatus(scope,proof);
   if(!job){results.push({outcome:'already_current'});continue;}
   let status;
   for(let i=0;i<120;i++){status=(await db.query('SELECT status,error_code FROM reading_listening67.web_homework_job WHERE id=$1',[job.id])).rows[0];if(['verified','blocked'].includes(status.status))break;await new Promise(r=>setTimeout(r,500));}
   if(status.status!=='verified')throw Error('DOC_REFRESH_'+status.status+':'+(status.error_code||''));
   const after=await runtime.docs.read(binding.document_id);
   if(!planReading67HomeworkWrite(after,{...binding,last_doc_text:proof.payload.text},{kind:'status',payload:proof.payload}).verified||outsideFingerprint(after,binding,proof.payload.text)!==item.fingerprint)throw Error('DOC_OUTSIDE_CONTENT_CHANGED');
   await fs.writeFile(path.join(evidenceDir,scope.ownerId+'-after.private.json'),JSON.stringify(after),{mode:0o600});
   results.push({outcome:'verified',scope,documentId:binding.document_id,text:proof.payload.text,link:proof.payload.link});
  }
  await fs.writeFile(path.join(evidenceDir,'results.private.json'),JSON.stringify(results,null,2),{mode:0o600});console.log(JSON.stringify({outcome:'verified',count:results.length}));
 }
}finally{await runtime.close();await db.close();}
