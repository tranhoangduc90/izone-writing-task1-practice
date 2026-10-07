// Mô phỏng lệnh Docs trên ký tự UTF-16 và định dạng, kiểm hành vi đọc lại.
// Dữ liệu giả gồm cảnh báo tách text run, hai kỹ năng, tab con và nội dung ngoài vùng.
// Không gọi Google; native readback thật vẫn cần trước production.
import test from 'node:test';
import assert from 'node:assert/strict';
import { planCompletionWarning, verifyCompletionWarning, COMPLETION_WARNING, CTA_TEXT } from '../src/reading-listening67/docs-warning.js';
const docId='fixture_document_123456789012345';
const code='67-reading-02';
const warningStyle={bold:true,fontSize:{magnitude:16,unit:'PT'},foregroundColor:{color:{rgbColor:{red:1,green:0,blue:0}}},underline:false};
const ctaStyle={link:{url:'https://example.invalid/check'},bold:true};
const codeStyle={fontSize:{magnitude:1,unit:'PT'},foregroundColor:{color:{rgbColor:{red:1,green:1,blue:1}}}};
function document(lines, revision='r1',tabId=null) {
  let index=1;
  const content=lines.map(line=>{
    const [text,style,split]=typeof line==='string'?[line,{}]:line;
    const start=index, value=text+'\n', elements=[];
    const pieces=split?[value.slice(0,split),value.slice(split)]:[value];
    for(const part of pieces){elements.push({startIndex:index,endIndex:index+part.length,textRun:{content:part,textStyle:structuredClone(style)}});index+=part.length;}
    return {startIndex:start,endIndex:index,paragraph:{elements}};
  });
  const body={content};
  return {documentId:docId,revisionId:revision,...(tabId?{tabs:[{tabProperties:{tabId},documentTab:{body}}]}:{body})};
}
function execute(before,requests) {
  const tab=before.tabs?.[0], body=tab?tab.documentTab.body:before.body;
  let chars=[];
  for(const p of body.content)for(const r of p.paragraph.elements)for(let i=0;i<r.textRun.content.length;i++)chars.push({text:r.textRun.content[i],style:structuredClone(r.textRun.textStyle)});
  for(const request of requests){
    if(request.deleteContentRange){const r=request.deleteContentRange.range;chars.splice(r.startIndex-1,r.endIndex-r.startIndex);}
    if(request.insertText){const i=request.insertText.location.index-1;chars.splice(i,0,...request.insertText.text.split('').map(text=>({text,style:structuredClone(chars[Math.max(0,i-1)]?.style||{})})));}
    if(request.updateTextStyle){const op=request.updateTextStyle;for(let i=op.range.startIndex-1;i<op.range.endIndex-1;i++){for(const field of op.fields.split(',')){delete chars[i].style[field];if(field in op.textStyle)chars[i].style[field]=structuredClone(op.textStyle[field]);}}}
  }
  let index=1, start=1, runs=[],content=[];
  for(const char of chars){runs.push({startIndex:index,endIndex:index+1,textRun:{content:char.text,textStyle:char.style}});index++;
    if(char.text==='\n'){content.push({startIndex:start,endIndex:index,paragraph:{elements:runs}});start=index;runs=[];}}
  assert.equal(runs.length,0,'Docs phải giữ newline cuối');
  const next=structuredClone(before);next.revisionId='r2';(next.tabs?.[0]?.documentTab?.body||next.body).content=content;return next;
}
const input={documentId:docId,assignmentCode:code,belowThreshold:true};
const base=()=>[[CTA_TEXT,ctaStyle],[code,codeStyle],'Câu trả lời 😀 giữ nguyên'];

test('CTA là nút trong bảng con, mã bài sau bảng: cảnh báo vẫn nằm đúng dưới mã',()=>{
  const doc=document(base(),'r1','t.0');
  const content=doc.tabs[0].documentTab.body.content;
  const cta=content.shift();
  content.unshift({startIndex:0,endIndex:cta.endIndex,table:{tableRows:[{tableCells:[{content:[cta]}]}]}});
  const plan=planCompletionWarning(doc,{...input,tabId:'t.0'});
  assert.equal(plan.requests[0].insertText.location.index,content[1].endIndex-1);
  assert.equal(plan.requests[0].insertText.location.tabId,'t.0');
  assert.equal(verifyCompletionWarning(doc,doc,planCompletionWarning(doc,{...input,tabId:'t.0',belowThreshold:false})).verified,true);
  const ambiguous=structuredClone(doc);
  ambiguous.tabs[0].documentTab.body.content.push(structuredClone(content[1]));
  assert.throws(()=>planCompletionWarning(ambiguous,{...input,tabId:'t.0'}),/WARNING_ANCHOR_AMBIGUOUS/);
});
test('CTA và mã bài ở hai hàng riêng của bảng Listening: neo cảnh báo trong cell chứa mã',()=>{
  const doc=document(base(),'r1','t.0');const lines=doc.tabs[0].documentTab.body.content;
  doc.tabs[0].documentTab.body.content=[{table:{tableRows:lines.map(p=>({tableCells:[{content:[p]}]}))}}];
  const plan=planCompletionWarning(doc,{...input,tabId:'t.0'});
  assert.equal(plan.requests[0].insertText.location.index,lines[1].endIndex-1);
  assert.equal(verifyCompletionWarning(doc,doc,planCompletionWarning(doc,{...input,tabId:'t.0',belowThreshold:false})).verified,true);
});
test('File có mã bài nhưng chưa có CTA vẫn ghi đúng cảnh báo dưới mã',()=>{
  const before=document(base().slice(1));const plan=planCompletionWarning(before,input);
  const after=execute(before,plan.requests);assert.equal(verifyCompletionWarning(before,after,plan).warningState,'present_verified');
});
test('Cảnh báo ở paragraph sau mã, đỏ/đậm/16pt/không link và giữ câu trả lời',()=>{
  const before=document(base());const plan=planCompletionWarning(before,input);const after=execute(before,plan.requests);
  assert.equal(after.body.content[2].paragraph.elements.map(r=>r.textRun.content).join(''),COMPLETION_WARNING+'\n');
  assert.equal(verifyCompletionWarning(before,after,plan).warningState,'present_verified');
  assert.equal(planCompletionWarning(after,input).requests.length,0);
});
test('Đủ bài xóa paragraph cảnh báo, giữ newline cuối và mã ngay sau CTA',()=>{
  const before=document([...base().slice(0,2),[COMPLETION_WARNING,warningStyle],'Câu trả lời 😀 giữ nguyên']);
  const plan=planCompletionWarning(before,{...input,belowThreshold:false});const after=execute(before,plan.requests);
  assert.equal(verifyCompletionWarning(before,after,plan).warningState,'absent_verified');
  assert.equal(after.body.content.length,3);
  assert.equal(planCompletionWarning(after,{...input,belowThreshold:false}).requests.length,0);
});
test('Xóa cảnh báo cuối thân vẫn giữ newline bắt buộc của Docs',()=>{
  const before=document([...base().slice(0,2),[COMPLETION_WARNING,warningStyle]]);
  const plan=planCompletionWarning(before,{...input,belowThreshold:false});const after=execute(before,plan.requests);
  assert.equal(after.body.content.length,2);assert.equal(verifyCompletionWarning(before,after,plan).verified,true);
});
test('Chuẩn hóa cảnh báo cũ/trùng/tách text run thành đúng một paragraph',()=>{
  const before=document([...base().slice(0,2),['Hãy hoàn thành bài tập Reading (ít nhất là 80%) để được chấm bài.',{},15],[COMPLETION_WARNING,{bold:false},20],base()[2]]);
  const plan=planCompletionWarning(before,input),after=execute(before,plan.requests);
  assert.equal(verifyCompletionWarning(before,after,plan).verified,true);
  assert.equal(after.body.content.length,4);
});
test('Không xóa lời học viên có chữ 80% hoặc cảnh báo nằm ngoài vùng',()=>{
  const before=document([...base(),'Ghi chú của học viên: cần đạt 80%',COMPLETION_WARNING]);
  const plan=planCompletionWarning(before,{...input,belowThreshold:false});assert.equal(plan.requests.length,0);
  assert.equal(verifyCompletionWarning(before,before,plan).verified,true);
});
test('Reading đủ không xóa cảnh báo Listening trong cùng Docs',()=>{
  const before=document([...base(),[CTA_TEXT,ctaStyle],['67-listening-01',codeStyle],[COMPLETION_WARNING,warningStyle]]);
  const plan=planCompletionWarning(before,{...input,belowThreshold:false});assert.equal(plan.requests.length,0);
  assert.equal(verifyCompletionWarning(before,before,plan).warningState,'absent_verified');
});
test('Tab con được chọn đúng; nhiều mã trùng không tự đoán',()=>{
  const one=document(base(),'r1','child');const before={...one,tabs:[{tabProperties:{tabId:'parent'},documentTab:{body:{content:[]}},childTabs:one.tabs}]};
  const plan=planCompletionWarning(before,{...input,tabId:'child'});assert.equal(plan.requests[0].insertText.location.tabId,'child');
  const duplicate={...one,tabs:[...one.tabs,...document(base(),'r1','other').tabs]};
  assert.throws(()=>planCompletionWarning(duplicate,input),/WARNING_ANCHOR_AMBIGUOUS/);
});
test('Readback phát hiện nội dung ngoài vùng và hyperlink CTA bị đổi',()=>{
  const before=document(base()),plan=planCompletionWarning(before,input),after=execute(before,plan.requests);
  const changed=structuredClone(after);changed.body.content.at(-1).paragraph.elements[0].textRun.content='X';
  assert.throws(()=>verifyCompletionWarning(before,changed,plan),/WARNING_READBACK_CONTENT_MISMATCH/);
  const link=structuredClone(after);link.body.content[0].paragraph.elements[0].textRun.textStyle.link={url:'https://wrong.invalid'};
  assert.throws(()=>verifyCompletionWarning(before,link,plan),/WARNING_READBACK_ANCHOR_STYLE_CHANGED/);
});
test('Readback phát hiện cảnh báo sai định dạng và tài liệu/revision sai',()=>{
  const before=document(base()),plan=planCompletionWarning(before,input),after=execute(before,plan.requests);
  after.body.content[2].paragraph.elements[0].textRun.textStyle.bold=false;
  assert.throws(()=>verifyCompletionWarning(before,after,plan),/WARNING_READBACK_STYLE_OR_POSITION_INVALID/);
  assert.throws(()=>planCompletionWarning({...before,revisionId:null},input),/WARNING_DOCUMENT_REVISION_INVALID/);
});
