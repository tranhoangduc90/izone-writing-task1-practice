// Bảo vệ ranh giới ghi Google: không chạm bài khác/chữ tay, không coi request là readback.
import test from 'node:test';
import assert from 'node:assert/strict';
import {HOMEWORK_CTA as CTA,HOMEWORK_STATUS as STATUS,HOMEWORK_PREFIX as PREFIX,planReading67HomeworkWrite as plan,locateReading67Homework as locate} from '../src/reading-listening67/web-homework-docs.js';
const CODE='67-reading-materials-beyond-concrete-matching-information-nen-cap-1';
const OTHER='67-practice-reading_matching_names_sentence_endings_mcq';
const binding={document_id:'fixture_doc',tab_id:'child',code:CODE,last_doc_text:''};
const paragraph=(start,text,style={})=>({paragraph:{elements:[{startIndex:start,endIndex:start+text.length+1,textRun:{content:text+'\n',textStyle:style}}]}});
function table(code,start,status='Chữ tay phải giữ',style={}){
 return {table:{tableRows:[
  {tableCells:[{content:[paragraph(start,CTA,style),paragraph(start+100,code)]}]},
  {tableCells:[{content:[paragraph(start+300,STATUS)]}]},
  {tableCells:[{content:[paragraph(start+400,status,{link:{url:'https://manual.test/link'},bold:true})]}]}
 ]}};
}
function document(status='Chữ tay phải giữ'){
 return {documentId:'fixture_doc',revisionId:'revision_fixture',tabs:[{tabProperties:{tabId:'parent'},childTabs:[{tabProperties:{tabId:'child'},documentTab:{body:{content:[table(OTHER,1000,'Không được đổi bài kia'),table(CODE,2000,status)]}}}]}]};
}
const completed={kind:'status',payload:{text:'Đã hoàn thành ngay từ lần đầu. Giảng viên nhấn vào đây để xem kết quả.',link:'https://page.test/reading-skills67/?teacher=1&attempt=fixture'}};

test('Hai Reading cùng child tab: đúng cặp CTA–mã và đúng ô trạng thái của bài này',()=>{
 const doc=document(),located=locate(doc,binding);assert.equal(located.cta.start,2000);
 const cta=plan(doc,binding,{kind:'cta',payload:{url:'https://page.test/reading-skills67/'}});
 assert.equal(cta.revisionId,'revision_fixture');assert.equal(cta.requests.length,1);
 assert.deepEqual(cta.requests[0].updateTextStyle.range,{startIndex:2000,endIndex:2000+CTA.length,tabId:'child'});
 const status=plan(doc,binding,completed);
 assert.equal(status.requests[0].insertText.location.index,2400+'Chữ tay phải giữ'.length);
 assert.equal(status.requests[0].insertText.text,'\n'+PREFIX+completed.payload.text);
 assert.ok(status.requests.every(r=>!r.deleteContentRange));
 assert.ok(status.requests.filter(r=>r.updateTextStyle).every(r=>r.updateTextStyle.range.startIndex>2400+'Chữ tay phải giữ'.length));
});
test('CTA retry đọc đúng từng ký tự style và giữ mọi thuộc tính ngoài ba trường cho phép',()=>{
 const doc=document(),target=doc.tabs[0].childTabs[0].documentTab.body.content[1].table.tableRows[0].tableCells[0].content[0];
 target.paragraph.elements[0].textRun.textStyle={link:{url:'https://page.test/app'},underline:false,foregroundColor:{color:{rgbColor:{red:1,green:1,blue:1}}},bold:true};
 assert.deepEqual(plan(doc,binding,{kind:'cta',payload:{url:'https://page.test/app'}}).requests,[]);
 const changed=plan(doc,binding,{kind:'cta',payload:{url:'https://page.test/new'}});
 assert.equal(changed.requests[0].updateTextStyle.fields,'link,underline,foregroundColor');
});
test('Trạng thái đã ghi nhưng mất ACK: đọc lại đúng chữ/link không tạo request hoặc dòng thứ hai',()=>{
 const doc=document('Chữ tay phải giữ\n'+PREFIX+completed.payload.text),cell=locate(doc,binding).cell;
 const run=cell.content[0].paragraph.elements[0];
 const raw=run.textRun.content,index=raw.indexOf('nhấn vào đây'),start=run.startIndex;
 cell.content[0].paragraph.elements=[
  {startIndex:start,textRun:{content:raw.slice(0,index),textStyle:{link:{url:'https://manual.test/link'}}}},
  {startIndex:start+index,textRun:{content:'nhấn vào đây',textStyle:{link:{url:completed.payload.link}}}},
  {startIndex:start+index+'nhấn vào đây'.length,textRun:{content:raw.slice(index+'nhấn vào đây'.length),textStyle:{}}}
 ];
 assert.equal(plan(doc,binding,completed).verified,true);
 assert.deepEqual(plan(doc,binding,completed).requests,[]);
});
test('Chỉ thay dòng tự động đã biết, giữ nguyên phần chữ/link nhập tay trước và sau',()=>{
 const old='Đã bắt đầu làm bài lần đầu tiên.',manual='Ghi chú trước\n',suffix='\nGhi chú sau';
 const doc=document(manual+PREFIX+old+suffix),result=plan(doc,{...binding,last_doc_text:old},completed);
 assert.deepEqual(result.requests[0].deleteContentRange.range,{startIndex:2400+manual.length,endIndex:2400+manual.length+PREFIX.length+old.length,tabId:'child'});
 assert.equal(result.requests[1].insertText.text,PREFIX+completed.payload.text);
});
test('Dòng tự động sửa tay, bị xóa hoặc trùng thì dừng; không ghi đè hoặc chèn dòng thay thế',()=>{
 for(const value of ['Chữ tay\n'+PREFIX+'GV đã sửa','Chữ tay',PREFIX+'Một\n'+PREFIX+'Hai']){
  assert.throws(()=>plan(document(value),{...binding,last_doc_text:'Đã ghi trước'},completed),e=>['DOC_MANUAL_CONFLICT','DOC_STATUS_AMBIGUOUS'].includes(e.code));
 }
});
test('Sai tài liệu/tab, mã inline/trùng và CTA không kề mã đều bị chặn trước Google',()=>{
 assert.throws(()=>plan(document(),{...binding,document_id:'other'},completed),e=>e.code==='DOC_IDENTITY_MISMATCH');
 assert.throws(()=>plan(document(),{...binding,tab_id:'absent'},completed),e=>e.code==='DOC_TAB_NOT_FOUND');
 for(const change of [
  doc=>doc.tabs[0].childTabs[0].documentTab.body.content.push(table(CODE,3000)),
  doc=>{doc.tabs[0].childTabs[0].documentTab.body.content[1].table.tableRows[0].tableCells[0].content[1]=paragraph(2100,'Mã: '+CODE);},
  doc=>{doc.tabs[0].childTabs[0].documentTab.body.content[1].table.tableRows[0].tableCells[0].content[0]=paragraph(2000,'Nút khác');}
 ]){const doc=document();change(doc);assert.throws(()=>plan(doc,binding,completed));}
});
test('Mã không có ranh giới bảng và nhiều ô trạng thái: không chọn ô đầu theo vị trí',()=>{
 const doc=document();doc.tabs[0].childTabs[0].documentTab.body.content=[paragraph(1,CTA),paragraph(100,CODE),table(OTHER,1000),table('67-other',2000)];
 assert.throws(()=>plan(doc,binding,completed),e=>e.code==='DOC_STATUS_AMBIGUOUS');
});
