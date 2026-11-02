// Dữ liệu giả kiểm qua API bài làm thật: ba mức đồng ý, đúng nguồn và tương thích Lesson11.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createStore} from '../src/store.mjs';
import {createService} from '../src/service.mjs';
const opinion={activity:'lesson13',number:13,topic:'Younger people as leaders.',classes:['fixture'],promptVersion:'lesson13-rubric-test',handoutMode:'two-bodies-v1',preparationMode:'ideas-first-v1',preparationKind:'opinion-v1',solutionOptions:['Lãnh đạo trẻ tuổi','Lãnh đạo lớn tuổi'],workflowMode:'whole-chain-v1',bodies:[{body:1},{body:2}]};
const old={...opinion,activity:'lesson11',number:11,promptVersion:'lesson11-rubric-test',preparationKind:undefined,solutionOptions:undefined};
async function fixture(t){
 const db=new PGlite();for(const f of ['001-initial.sql','002-activity-log.sql'])await db.exec(await readFile(new URL('../db/'+f,import.meta.url),'utf8'));
 const store=createStore(db),service=createService({store,roster:async()=>[{classRef:'fixture',students:[{studentRef:'s'}]}],secret:'s'.repeat(40),lessons:{lesson11:old,lesson13:opinion},renderJob:j=>'Pinned '+JSON.stringify(j.snapshot)});
 const {session,token}=await service.open({activity:'lesson13',classRef:'fixture',studentRef:'s'}),ref=session.ref;
 const read=()=>service.read(ref,token),input=async more=>({baseVersion:(await read()).version,requestId:crypto.randomUUID(),...more});
 const save=async responses=>service.save(ref,token,await input({responses}));
 const check=()=>service.check(ref,token,{});
 const submit=async()=>service.check(ref,token,await input({section:'outline',bodyIndex:0}));
 const attest=async()=>service.attest(ref,token,await input({section:'outline',bodyIndex:0,teacherPermission:true}));
 const ideas={chosenSolution:'Lãnh đạo trẻ tuổi',agreementLevel:'Đồng ý hoàn toàn',positionLimit:'',body1_idea1:'Hạn chế về thay đổi công nghệ',body1_idea2:'Hạn chế về góc nhìn thị trường mới',body2_idea1:'Khả năng ứng dụng công nghệ',body2_idea2:'Thích nghi thị trường'};
 t.after(()=>db.close());return {db,store,service,ref,token,read,input,save,check,submit,attest,ideas};
}
for(const [level,choice,limit] of [['Đồng ý hoàn toàn','Lãnh đạo trẻ tuổi',''],['Phản đối hoàn toàn','Lãnh đạo lớn tuổi',''],['Đồng ý một phần','Lãnh đạo trẻ tuổi','Ưu tiên khi đã có năng lực, vẫn cần cố vấn kinh nghiệm.'],['Đồng ý một phần','Lãnh đạo lớn tuổi','Ưu tiên tổ chức rủi ro cao, vẫn cần cập nhật công nghệ.']])test('L13 · '+level+' · '+choice,async t=>{
 const h=await fixture(t);await h.save({...h.ideas,agreementLevel:level,chosenSolution:choice,positionLimit:limit});await h.submit();
 const [job]=await h.service.claim();assert.equal(job.section,'outline');assert.equal(job.bodyIndex,0);assert.equal(job.ideaIndex,0);assert.equal(job.snapshot.preparationKind,'opinion-v1');assert.equal(job.snapshot.responses.agreementLevel,level);
 await h.service.complete({...job,result:{resultStatus:'passed',feedback:'Kế hoạch đúng lập trường và thứ tự.'}});
 await h.save({body1_topicSentence:'Body one',body2_topicSentence:'Body two'});assert.equal((await h.read()).responses.positionLimit,limit);
});
test('L13 · thiếu mức đồng ý/điều kiện và lập trường mâu thuẫn bị chặn trước AI',async t=>{
 const h=await fixture(t);await h.save({...h.ideas,agreementLevel:''});await assert.rejects(()=>h.submit(),/EMPTY_RESPONSE/);
 await h.save({agreementLevel:'Đồng ý một phần'});await assert.rejects(()=>h.submit(),/EMPTY_RESPONSE/);
 await h.save({agreementLevel:'Phản đối hoàn toàn'});await assert.rejects(()=>h.submit(),/AGREEMENT_SOLUTION_MISMATCH/);
 await h.save({agreementLevel:'arbitrary'});await assert.rejects(()=>h.submit(),/AGREEMENT_INVALID/);
 await h.save({agreementLevel:'Đồng ý hoàn toàn',chosenSolution:'Đường tàu và tàu điện ngầm'});await assert.rejects(()=>h.submit(),/SOLUTION_INVALID/);
 assert.deepEqual(await h.service.claim(),[]);
});
test('L13 · sửa điều kiện scope0 giữ chữ, hủy kết quả phụ thuộc và chặn callback cũ',async t=>{
 const h=await fixture(t);await h.save({...h.ideas,agreementLevel:'Đồng ý một phần',positionLimit:'Điều kiện gốc'});await h.submit();await h.attest();
 await h.save({body2_topicSentence:'Topic giữ nguyên'});await h.service.check(h.ref,h.token,await h.input({section:'body2_topic',bodyIndex:2}));const [job]=await h.service.claim();
 await assert.rejects(async()=>h.service.revise(h.ref,h.token,await h.input({field:'positionLimit',value:'Điều kiện mới',bodyIndex:2})),/BODY_IDENTITY_MISMATCH/);
 await h.service.revise(h.ref,h.token,await h.input({field:'positionLimit',value:'Điều kiện mới',bodyIndex:0}));
 const s=await h.read();assert.equal(s.responses.body2_topicSentence,'Topic giữ nguyên');assert.equal(s.steps.outline.status,'revision');assert.equal((await h.service.forProcessing(job)).status,'superseded');
 const late=await h.service.complete({...job,result:{resultStatus:'passed',feedback:'Kết quả cũ'}});assert.equal(late.status,'superseded');assert.notEqual((await h.read()).steps.body2_topic.status,'passed');
});
test('L11 · cùng học viên vẫn giữ schema19trường và chỉ nhận hai lựa chọn giao thông',async t=>{
 const h=await fixture(t),opened=await h.service.open({activity:'lesson11',classRef:'fixture',studentRef:'s'});assert.notEqual(opened.session.ref,h.ref);assert.equal(Object.keys(opened.session.responses).length,19);assert.equal(opened.session.preparationKind,undefined);
 await h.service.save(opened.session.ref,opened.token,{baseVersion:0,requestId:crypto.randomUUID(),responses:{chosenSolution:'Đường tàu và tàu điện ngầm',body1_idea1:'Một',body1_idea2:'Hai',body2_idea1:'Ba',body2_idea2:'Bốn'}});
 await h.service.check(opened.session.ref,opened.token,{baseVersion:1,requestId:crypto.randomUUID(),section:'outline',bodyIndex:0});assert.equal((await h.read()).steps.outline.status,'draft');
});
