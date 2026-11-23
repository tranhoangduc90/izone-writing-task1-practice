import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeacher} from '../src/teacher.mjs';
import {createApi} from '../src/http.mjs';
import {fail} from '../src/service.mjs';
import {LESSON6_SHARE_POLICY} from '../src/writing-lesson6.mjs';

test('Lecture directe Lesson 4: authenticated, class and session scoped, read-only',async t=>{
  const ref='b1ec47ec-bda8-444c-9216-97fa60529814',other='a74807c9-9e56-451b-9fe1-fbc1cd603542';
  const fields={body1_topicSentence:'Bản đã sửa',body1_idea1:'Ý A',body2_topicSentence:'Thông điệp B'};
  const session={ref,activity:'lesson4',classRef:'IC2363',studentRef:'test-a',outlineOnly:true,
    writingEntry:{assignmentId:'hw-k67-writing-lesson4-1356',contentVersion:1},practice:{status:'accepted'},
    responses:fields,steps:{
      body1_topic:{status:'revision',history:[{status:'passed',jobRef:'one',snapshot:{...fields,body1_topicSentence:'Bản trước'},feedback:'Phản hồi cũ'}]},
      body2_topic:{status:'passed',history:[{status:'passed',jobRef:'two',snapshot:fields,feedback:'Phản hồi hiện hành'}]}
    }};
  const account={email:'teacher@example.test',subject:'test-sub',classes:[],lessonClasses:{lesson4:['IC2363']}};
  const teacher=createTeacher({store:{read:async id=>id===ref?session:id===other?{...session,activity:'lesson5',ref:other}:null},
    roster:async()=>[{classRef:'IC2363',students:[{studentRef:'test-a',displayName:'Học viên A'}]}],
    registry:()=>({teachers:[account]}),secret:'x'.repeat(32),lessons:{lesson4:{classes:['IC2363']}}});
  const server=createApi({teacher,origins:[],internalSecret:'internal',verifySharedTeacher:async req=>{
    if(req.headers.cookie!=='fixture=teacher')fail('TEACHER_UNAUTHORIZED',401);
    return {email:account.email,emailVerified:true,sub:account.subject};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root='http://127.0.0.1:'+server.address().port+'/api/handout67/v1/teacher/lesson4-outline/';
  const headers={Cookie:'fixture=teacher'};
  assert.equal((await fetch(root+ref)).status,401);
  assert.equal((await fetch(root+other,{headers})).status,404);
  assert.equal((await fetch(root+'invalid',{headers})).status,404);
  assert.equal((await fetch(root+ref,{headers,method:'POST'})).status,404);
  const response=await fetch(root+ref,{headers});
  assert.equal(response.headers.get('cache-control'),'no-store');
  assert.deepEqual((await response.json()).outline,{ref,classRef:'IC2363',displayName:'Học viên A',passed:1,bodies:[
    {body:1,passed:false,status:'revision',fields:{topicSentence:'Bản đã sửa',idea1:'Ý A',idea2:''},feedback:'',feedbackFromEarlierVersion:true},
    {body:2,passed:true,status:'passed',fields:{topicSentence:'Thông điệp B',idea1:'',idea2:''},feedback:'Phản hồi hiện hành',feedbackFromEarlierVersion:false}
  ]});
  account.lessonClasses={lesson4:['IC9999']};
  assert.equal((await fetch(root+ref,{headers})).status,403);
});

test('Lesson 6 teacher view follows live completion and requires the right lesson, shared login and roster grant',async t=>{
  const ref='08471de0-3958-4282-a767-7327d6f7982f', wrongLesson='b1ec47ec-bda8-444c-9216-97fa60529814';
  const responses={stance:'agree',body1_topicSentence:'Lợi ích',body1_idea1:'Cảnh báo',body2_topicSentence:'Mối nguy',body2_idea1:'Tin sai'};
  const step=(direction,dimensions)=>({status:'passed',direction,dimensions,
    history:[{status:'passed',jobRef:'fixture-check',snapshot:{...responses},feedback:'Đã Check'}]});
  const session={ref,activity:'lesson6',classRef:'IC9006',studentRef:'test-a',outlineOnly:true,
    writingEntry:{assignmentId:'hw-k67-writing-lesson6-9006',contentVersion:1},practice:{status:'accepted',policy:LESSON6_SHARE_POLICY},
    responses,steps:{body1_topic:step('disagree',['access','rapid']),body2_topic:step('agree',['exchange','uncontrolled'])}};
  const account={email:'teacher@example.test',subject:'test-sub',classes:[],lessonClasses:{lesson6:['IC9006']}};
  const room={classRef:'IC9006',students:[{studentRef:'test-a',displayName:'Học viên mẫu'}]};
  const teacher=createTeacher({store:{read:async id=>id===ref?session:id===wrongLesson?{...session,activity:'lesson4'}:null},
    roster:async()=>[room],registry:()=>({teachers:[account]}),secret:'x'.repeat(32),
    lessons:{lesson6:{classes:['IC9006'],sharePolicy:LESSON6_SHARE_POLICY}}});
  const server=createApi({teacher,origins:[],internalSecret:'internal',verifySharedTeacher:async req=>{
    if(req.headers.cookie!=='fixture=teacher')fail('TEACHER_UNAUTHORIZED',401);
    return {email:account.email,emailVerified:true,sub:account.subject};
  }});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const root='http://127.0.0.1:'+server.address().port+'/api/handout67/v1/teacher/';
  const options={headers:{Cookie:'fixture=teacher'}};
  const read=id=>fetch(root+'lesson6-outline/'+id,options);
  const outline=async()=>{const response=await read(ref);assert.equal(response.status,200);return (await response.json()).outline;};
  assert.equal((await fetch(root+'lesson6-outline/'+ref)).status,401);
  assert.equal((await read(wrongLesson)).status,404);
  assert.equal((await fetch(root+'lesson4-outline/'+ref,options)).status,404);
  assert.equal((await fetch(root+'lesson6-outline/'+ref,{...options,method:'POST'})).status,404);
  let shown=await outline();
  assert.deepEqual([shown.ref,shown.activity,shown.classRef,shown.displayName,shown.stance,shown.passed,shown.completed,shown.relation],
    [ref,'lesson6','IC9006','Học viên mẫu','agree',2,true,'passed']);
  assert.equal(shown.bodies[1].feedback,'Đã Check');
  session.steps.body2_topic.dimensions=['exchange'];
  shown=await outline();
  assert.deepEqual([shown.passed,shown.completed,shown.relation,shown.missingDimensions],[2,false,'coverage',['uncontrolled']]);
  session.responses.body2_idea1='Đã sửa';
  session.steps.body2_topic.status='revision';
  shown=await outline();
  assert.equal(shown.passed,1);
  assert.equal(shown.bodies[1].fields.idea1,'Đã sửa');
  assert.equal(shown.bodies[1].feedback,'');
  assert.equal(shown.bodies[1].feedbackFromEarlierVersion,true);
  session.practice.policy='old-policy';
  assert.equal((await read(ref)).status,404);
  session.practice.policy=LESSON6_SHARE_POLICY;
  account.lessonClasses={lesson6:['IC9007']};
  assert.equal((await read(ref)).status,403);
  account.lessonClasses={lesson6:['IC9006']};
  room.students=[];
  assert.equal((await read(ref)).status,403);
});
