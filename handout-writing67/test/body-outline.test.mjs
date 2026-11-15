import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {createService} from '../src/service.mjs';
import {createStore} from '../src/store.mjs';
import {outlineRelation,workflowFor,available} from '../src/workflow.mjs';

const passed=direction=>({status:'passed',direction});
const session=(stance,first,second)=>({outlineOnly:true,responses:{stance},steps:{body1_topic:first,body2_topic:second}});

test('Lesson 3 chỉ chấm hai thân và thân 2 mở ngay cả khi thân 1 trống',()=>{
 const state=session('disagree',{status:'draft'},{status:'draft'});
 assert.deepEqual(workflowFor(state).order,['body1_topic','body2_topic']);
 assert.equal(available(state,'body2_topic'),true);
 assert.equal(available(state,'body2_si1'),false);
 assert.equal(outlineRelation(state),'waiting');
});

test('Đối chiếu phân biệt hướng, thứ tự, cân bằng và bản chưa đạt',()=>{
 const agree=passed('agree'),disagree=passed('disagree'),balanced=passed('balanced');
 for(const [stance,first,second,expected] of [
  ['disagree',disagree,agree,'order'],['agree',agree,disagree,'order'],
  ['disagree',agree,disagree,'passed'],['agree',disagree,agree,'passed'],
  ['disagree',agree,agree,'stance'],['agree',agree,agree,'passed'],
  ['balanced',disagree,agree,'passed'],['balanced',agree,disagree,'passed'],
  ['balanced',balanced,balanced,'passed'],['disagree',balanced,disagree,'passed'],
  ['agree',balanced,disagree,'stance'],['disagree',agree,{status:'revision',direction:'disagree'},'waiting'],
  ['',agree,disagree,'waiting']
 ])assert.equal(outlineRelation(session(stance,first,second)),expected);
});

test('Lesson 3 lưu phản hồi 102 từ sau Check và vẫn từ chối phản hồi sai hợp đồng',async t=>{
 const db=new PGlite();
 t.after(()=>db.close());
 for(const file of ['001-initial.sql','002-activity-log.sql']){
  await db.exec(await readFile(new URL('../db/'+file,import.meta.url),'utf8'));
 }
 const lesson=JSON.parse(await readFile(new URL('../lesson-definitions/lesson3.json',import.meta.url),'utf8'));
 const service=createService({
  store:createStore(db),secret:'lesson3-fixture-session-secret'.padEnd(40,'s'),
  lessons:{lesson3:{...lesson,promptVersion:'lesson3-fixture-v1',classes:['IC9999']}},
  roster:async()=>[{classRef:'IC9999',students:[{studentRef:'fixture',displayName:'Học viên thử'}]}]
 });
 const {session,token}=await service.open({activity:'lesson3',classRef:'IC9999',studentRef:'fixture'});
 await service.save(session.ref,token,{baseVersion:0,requestId:'save-outline',responses:{
  stance:'disagree',body2_topicSentence:'Measures other than bans can improve public health.',
  body2_idea1:'Teach nutrition at school',body2_idea2:'Make healthy meals more affordable'
 }});
 await service.check(session.ref,token,{baseVersion:1,requestId:'check-body-2',section:'body2_topic',bodyIndex:2});
 const [job]=await service.claim();
 const feedback='Hai ý cùng làm rõ thông điệp.'.split(/\s+/);
 const result={resultStatus:'passed',direction:'disagree',feedback:Array.from({length:102},(_,i)=>feedback[i%feedback.length]).join(' ')};
 for(const invalid of [{...result,direction:'unclear'},{...result,extra:true},{...result,feedback:'từ '.repeat(151)}]){
  await assert.rejects(()=>service.complete({...job,result:invalid}),/RESULT_INVALID/);
 }
 const outputText='\x60\x60\x60json\n'+JSON.stringify(result)+'\n\x60\x60\x60';
 const receipt=await service.receive({...job,outputText,httpStatus:200,model:'fixture'});
 assert.equal(receipt.status,'completed');
 const restored=await service.read(session.ref,token);
 assert.equal(restored.steps.body2_topic.status,'passed');
 assert.equal(restored.steps.body2_topic.history.length,1);
 assert.equal(restored.steps.body2_topic.history[0].feedback,result.feedback);
 const audit=await db.query('SELECT status,response_text FROM handout67.grading_attempt WHERE job_ref=$1',[job.jobRef]);
 assert.deepEqual(audit.rows,[{status:'completed',response_text:outputText}]);
});
