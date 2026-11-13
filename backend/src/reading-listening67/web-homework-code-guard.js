/** Kiểm mã trên mọi bản Docs vừa đọc, gồm snapshot worker dùng để lập lệnh và đọc lại. */
import {WebGradingError} from './web-grader.js';
import {homeworkMarkerTabs} from './web-homework-docs.js';
export function guardReading67HomeworkDocs(docs,managedCodes=[]){
 const codes=Object.freeze([...new Set(managedCodes)]);
 if(codes.length<2)return docs;
 return {...docs,async read(id,options){
  const document=await docs.read(id,options);
  if(codes.filter(code=>homeworkMarkerTabs(document,code).length).length>1)throw new WebGradingError('DOC_CODE_MISMATCH',409);
  return document;
 }};
}
