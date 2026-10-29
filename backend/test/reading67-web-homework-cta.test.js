// Kiểm giao thức HTTP CTA và lựa chọn đúng chủ trước đăng ký; không gọi Google.
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {createReading67WebRouter} from '../src/reading-listening67/web-routes.js';
import {createReading67CtaRegistrar,createReading67CtaDispatcher} from '../src/reading-listening67/web-homework-cta.js';
import {HOMEWORK_CTA,HOMEWORK_STATUS} from '../src/reading-listening67/web-homework-docs.js';
const code='67-reading-materials-beyond-concrete-matching-information-nen-cap-1',version='fixture-v1',A='11111111-1111-4111-8111-111111111111';
const event={doc_id:'document-fixture-1234567890',classroom_course_id:'course-A',coursework_id:'work78',submission_id:'sub-A',student_id:'google-A',class_name:'TESTA'};
const paragraph=(start,text,style={})=>({paragraph:{elements:[{startIndex:start,textRun:{content:text+'\n',textStyle:style}}]}});
function fixture(){
 const state={status:'verified',className:'TESTA',registered:[],read:0,wrongOwner:false};
 const entryUrl='https://page.test/reading-skills67/?server=1&assignmentCode='+code;
 const document={documentId:event.doc_id,revisionId:'r1',tabs:[{tabProperties:{tabId:'t.0'},documentTab:{body:{content:[{table:{tableRows:[{tableCells:[{content:[paragraph(1,HOMEWORK_CTA,{link:{url:entryUrl},foregroundColor:{color:{rgbColor:{red:1,green:1,blue:1}}},underline:false}),paragraph(100,code)]}]},{tableCells:[{content:[paragraph(300,HOMEWORK_STATUS)]}]},{tableCells:[{content:[paragraph(500,'Ghi chú tay')]}]}]}}]}}}]};
 const homework={entryUrl,register:async(s,t)=>{state.registered.push({scope:s,target:t});},status:async()=>({cta:state.status})};
 const owner={resolveClassroom:async input=>{assert.deepEqual(input,{courseId:'course-A',googleUserId:'google-A'});if(state.wrongOwner)throw Object.assign(Error(),{code:'OWNER_MISMATCH'});return {classId:'1124',studentRef:A};}};
 const docs={read:async()=>{state.read++;return document;}};
 const registrar=createReading67CtaRegistrar({homework,owner,docs,identity:{member:async()=>({className:state.className})},metadata:{code,version},waitMs:0});
 return {state,document,registrar,docs};
}
test('CTA verified chỉ sau đăng ký đúng event/mapping và đọc lại link đúng mã; retry giữ cùng đích',async()=>{
 const f=fixture();for(let i=0;i<2;i++)assert.equal((await f.registrar(event)).status,'verified');
 assert.equal(f.state.read,4);assert.equal(f.state.registered.length,2);
 assert.deepEqual(f.state.registered[0],f.state.registered[1]);
 assert.deepEqual(f.state.registered[0].scope,{ownerId:A,courseId:'1124',code,version});
 assert.equal(f.state.registered[0].target.submissionId,event.submission_id);
});
test('Docs thêm mã bài khác giữa dispatcher và registrar: dừng trước đăng ký',async()=>{
 const f=fixture(),other='new-reading-homework-code',read=f.docs.read;
 f.docs.read=async()=>{const doc=await read();if(f.state.read===2)doc.tabs[0].documentTab.body.content.push(paragraph(900,other));return doc;};
 const run=createReading67CtaDispatcher({docs:f.docs,registrars:[{code,registerCta:f.registrar},{code:other,registerCta:async()=>assert.fail('Must not select another code')} ]});
 await assert.rejects(run(event),e=>e.code==='DOC_CODE_MISMATCH');assert.equal(f.state.registered.length,0);
});
test('CTA pending/blocked không báo thành công; sai lớp hoặc mapping chặn trước đăng ký',async()=>{
 for(const status of ['pending','blocked']){const f=fixture();f.state.status=status;await assert.rejects(f.registrar(event),e=>e.code===(status==='pending'?'CTA_PENDING':'CTA_WRITE_BLOCKED'));}
 for(const kind of ['class','owner']){const f=fixture();if(kind==='class')f.state.className='TESTB';else f.state.wrongOwner=true;await assert.rejects(f.registrar(event));assert.equal(f.state.registered.length,0);}
});
test('Không có mã thì bỏ qua; mã lặp hoặc CTA không đứng ngay trước mã bị chặn',async()=>{
 const f=fixture();f.document.tabs[0].documentTab.body.content=[];assert.equal((await f.registrar(event)).status,'not_applicable');assert.equal(f.state.registered.length,0);
 const duplicate=fixture();duplicate.document.tabs.push(structuredClone(duplicate.document.tabs[0]));await assert.rejects(duplicate.registrar(event),e=>e.code==='DOC_CODE_MISMATCH');
 const invalid=fixture();invalid.document.tabs[0].documentTab.body.content[0].table.tableRows[0].tableCells[0].content.unshift(paragraph(0,'Chữ xen vào'));invalid.document.tabs[0].documentTab.body.content[0].table.tableRows[0].tableCells[0].content.splice(2,0,paragraph(50,'Sai cặp'));
 await assert.rejects(invalid.registrar(event),e=>e.code==='DOC_CTA_PAIR_INVALID');
});
test('HTTP admin không nhận cookie/học viên thay khóa; input sai hoặc lỗi pending giữ đúng mã',async()=>{
 const key='private-test-cta-key-32-characters-minimum';let calls=0;
 const app=express();app.use('/api',createReading67WebRouter({content:{code,version},store:{},grader:{},authenticate:async()=>null,adminKey:key,registerCta:async value=>{calls++;if(value.class_name==='PENDING')throw Object.assign(new (await import('../src/reading-listening67/web-grader.js')).WebGradingError('CTA_PENDING',503));return {status:'verified',documentId:value.doc_id};}}));
 await request(app).post('/api/admin/register-cta').send(event).expect(401);
 await request(app).post('/api/admin/register-cta').set('Authorization','Bearer wrong').send(event).expect(401);
 await request(app).post('/api/admin/register-cta').set('Authorization','Bearer '+key).send({...event,doc_id:'short'}).expect(400);
 const ok=await request(app).post('/api/admin/register-cta').set('Authorization','Bearer '+key).send({...event,untrusted_link:'https://wrong.test'}).expect(200);assert.equal(ok.body.status,'verified');
 const pending=await request(app).post('/api/admin/register-cta').set('Authorization','Bearer '+key).send({...event,class_name:'PENDING'}).expect(503);assert.equal(pending.body.error,'CTA_PENDING');assert.equal(calls,2);
 await request(app).get('/api/homework').expect(401);
});
