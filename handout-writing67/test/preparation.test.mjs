import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createStore} from '../src/store.mjs';
import {createService} from '../src/service.mjs';
const choice='Đường tàu và tàu điện ngầm';
const lesson={activity:'lesson11',number:11,topic:'Discuss rail and wider roads.',classes:['fixture'],promptVersion:'lesson11-rubric-ideas-first-test',handoutMode:'two-bodies-v1',preparationMode:'ideas-first-v1',workflowMode:'whole-chain-v1',bodies:[{body:1},{body:2}]};
async function fixture(t){
 const db=new PGlite();for(const f of ['001-initial.sql','002-activity-log.sql'])await db.exec(await readFile(new URL('../db/'+f,import.meta.url),'utf8'));
 const store=createStore(db),service=createService({store,roster:async()=>[{classRef:'fixture',students:[{studentRef:'s'}]}],secret:'s'.repeat(40),lessons:{lesson11:lesson},renderJob:j=>'Prompt '+j.section});
 const {session,token}=await service.open({activity:'lesson11',classRef:'fixture',studentRef:'s'}),ref=session.ref;
 const read=()=>service.read(ref,token),input=async body=>({baseVersion:(await read()).version,requestId:crypto.randomUUID(),...body});
 const save=async responses=>service.save(ref,token,await input({responses}));
 const check=async(section,bodyIndex)=>service.check(ref,token,await input({section,bodyIndex}));
 const attest=async(section,bodyIndex)=>service.attest(ref,token,await input({section,bodyIndex,teacherPermission:true}));
 const ideas={chosenSolution:choice,body1_idea1:'Mở rộng đường khó thực hiện ở nơi thiếu đất',body1_idea2:'Đường rộng có thể lại thu hút thêm xe cá nhân',body2_idea1:'Tàu chở nhiều người giúp giảm xe cá nhân',body2_idea2:'Tàu dùng tuyến riêng nên không tạo dòng xe tại nút giao'};
 const plan=async()=>{await save(ideas);await check('outline',0);await attest('outline',0);};
 const pass=async(n,key)=>{const values=key==='topic'?{['body'+n+'_topicSentence']:'Topic cho thân bài '+n}:Object.fromEntries(['a','x','b'].map(k=>['body'+n+'_'+k+key.at(-1),'Nội dung '+n+' '+k+key.at(-1)]));await save(values);await check('body'+n+'_'+key,n);await attest('body'+n+'_'+key,n);};
 t.after(()=>db.close());return {db,store,service,ref,token,read,input,save,check,attest,ideas,plan,pass};
}
test('P11 · bốn idea và lựa chọn được chấm trước; chưa có Topic và hai body đều khóa',async t=>{
 const h=await fixture(t),s=await h.read();assert.equal(s.preparationMode,'ideas-first-v1');assert.ok(s.steps.outline);assert.equal(Object.keys(s.responses).length,19);
 await assert.rejects(()=>h.save({body1_topicSentence:'Topic sớm'}),/FIELD_LOCKED/);
 await h.save({...h.ideas,body2_idea2:''});await assert.rejects(()=>h.check('outline',0),/EMPTY_RESPONSE/);
 await h.save({body2_idea2:h.ideas.body2_idea2});await h.check('outline',0);const [j]=await h.service.claim();assert.equal(j.bodyIndex,0);assert.equal(j.snapshot.preparationMode,'ideas-first-v1');assert.equal(j.section,'outline');
 await h.service.complete({...j,result:{resultStatus:'needs_revision',feedback:'Hướng so sánh chưa rõ.'}});await assert.rejects(()=>h.check('body2_topic',2),/STEP_LOCKED/);
 await h.attest('outline',0);await h.save({body1_topicSentence:'Topic một',body2_topicSentence:'Topic hai'});assert.equal((await h.read()).responses.body1_idea1,h.ideas.body1_idea1);
});
test('P11 · Topic chỉ nhận câu Topic; idea đã chốt không được autosave sửa lén',async t=>{
 const h=await fixture(t);await h.plan();await assert.rejects(()=>h.save({body1_idea1:'Sửa lén'}),/FIELD_LOCKED/);
 await h.save({body1_topicSentence:'Topic bao quát hai idea'});await h.check('body1_topic',1);const [j]=await h.service.claim();assert.equal(j.bodyIndex,1);assert.equal(j.snapshot.responses.chosenSolution,choice);
 await h.service.complete({...j,result:{resultStatus:'passed',feedback:'Topic đủ bao quát. 👍'}});assert.equal((await h.read()).steps.body1_topic.status,'passed');assert.equal((await h.read()).steps.body2_topic.status,'draft');
 await assert.rejects(()=>h.check('outline',2),/BODY_IDENTITY_MISMATCH/);
});
test('P11 · đổi kế hoạch giữ bài/lịch sử nhưng bỏ thông qua phụ thuộc và callback cũ',async t=>{
 const h=await fixture(t);await h.plan();await h.pass(1,'topic');await h.pass(1,'si1');await h.service.openIdea2(h.ref,h.token,{bodyIndex:1});await h.pass(1,'si2');const [vocab]=await h.service.claim();assert.equal(vocab.kind,'vocab');
 const before=await h.read();await h.service.revise(h.ref,h.token,await h.input({field:'body1_idea1',value:'Ý đã điều chỉnh trong kế hoạch',bodyIndex:1}));
 const s=await h.read();assert.equal(s.steps.outline.status,'revision');assert.notEqual(s.steps.body1_topic.status,'passed');assert.notEqual(s.steps.body1_si2.status,'passed');assert.equal(s.bodyProgress[1].idea2Open,false);assert.equal(s.vocabulary.body1,undefined);assert.equal(s.responses.body1_a1,before.responses.body1_a1);assert.equal(s.steps.body1_si1.history.length,before.steps.body1_si1.history.length);
 assert.equal((await h.service.forProcessing(vocab)).status,'superseded');await assert.rejects(()=>h.save({body2_topicSentence:'Chưa chốt lại'}),/FIELD_LOCKED/);
});
test('P11 · lựa chọn ngoài hai phương án và bỏ bodyIndex của bước chung bị từ chối',async t=>{
 const h=await fixture(t);await h.save({...h.ideas,chosenSolution:'Một phương án thứ ba'});await assert.rejects(()=>h.check('outline',0),/SOLUTION_INVALID/);
 await h.save({chosenSolution:choice});await assert.rejects(()=>h.check('outline',undefined),/BODY_IDENTITY_MISMATCH/);await h.check('outline',0);await h.attest('outline',0);
 await h.service.revise(h.ref,h.token,await h.input({field:'chosenSolution',value:'Thêm đường và mở rộng đường bộ',bodyIndex:0}));assert.equal((await h.read()).steps.outline.status,'revision');
});
