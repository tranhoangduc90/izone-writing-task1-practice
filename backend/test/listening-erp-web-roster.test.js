import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {createReading67WebIdentity} from '../src/reading-listening67/web-identity.js';
const {createListeningContext}=await import(process.env.LISTENING_CONTEXT_TEST_FILE?pathToFileURL(process.env.LISTENING_CONTEXT_TEST_FILE).href:'../src/listening-homework67/context.js');
// Nguồn ERP giả giữ ID thật của fixture; kiểm mở/đọc lại và thu hồi trước mọi ghi.
test('Listening ERP pending: hiện tên, đăng nhập/nhớ đúng ERP, không duyệt Google; nguồn thu hồi chặn phiên',async()=>{
 const ref='11111111-1111-4111-8111-111111111111';let clock=Date.now(),eligible=true;
 const student={public_id:ref,erp_course_class_id:'1333',erp_student_contact_id:'11',erp_student_name_snapshot:'Tên ERP',status:'pending_review'};
 const payload={apiVersion:1,productId:'PRODUCT-TERM-MINI-K67',classes:[{erp_course_class_id:'1333',erp_class_name_snapshot:'FixtureA',erp_course_id:'5'}],students:[student],memberships:[{erp_course_class_id:'1333',erp_student_contact_id:'11',source_state:'active'}],accounts:[],access:[]};
 const context=createListeningContext({url:'http://fixture',key:'fixture',allowedClassIds:['1333'],erpHomeworkClassIds:['1333'],clock:()=>clock,fetcher:async url=>Response.json(url.endsWith('/snapshot')?{...payload,capturedAt:new Date(clock).toISOString(),sourceRevision:createHash('sha256').update(JSON.stringify(payload)).digest('hex')}:{ok:true,capturedAt:new Date(clock).toISOString(),students:eligible?[student]:[]})});
 const sessions=new Map();const identity=createReading67WebIdentity({db:{async query(sql,p){if(sql.startsWith('INSERT')){sessions.set(p[0],{owner_id:p[1],course_id:p[2],erp_id:p[3]});return {rows:[]};}return {rows:sessions.has(p[0])?[sessions.get(p[0])]:[]};}},context,allowedClassIds:['1333'],clock:()=>clock});
 assert.equal((await identity.roster('1333')).length,1);
 const opened=await identity.loginStudent({classId:'1333',studentRef:ref});assert.equal(opened.identity.erpId,'11');
 assert.equal((await identity.resolve({studentRef:ref})).status,'unique');
 assert.equal((await context.snapshot()).students[0].status,'pending_review');
 assert.equal((await identity.authenticate({headers:{authorization:'Bearer '+opened.token}})).ownerId,ref);
 eligible=false;clock+=31000;await assert.rejects(identity.authenticate({headers:{authorization:'Bearer '+opened.token}}),e=>e.code==='STUDENT_ACCESS_DENIED');
 assert.equal(sessions.size,1);
});
