import test from 'node:test';
import assert from 'node:assert/strict';
import {createTeacher} from '../src/teacher.mjs';
import {createApi} from '../src/http.mjs';
import {fail} from '../src/service.mjs';

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
