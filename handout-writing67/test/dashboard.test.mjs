import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardProjection,markDashboardActivity} from '../src/dashboard.mjs';
import {ORDER} from '../src/service.mjs';
const fixture=()=>({ref:'fixture',responses:{idea1:'Ý 1',idea2:'Ý 2',topicSentence:'Topic',a1:'',x1:'',b1:'',a2:'',x2:'',b2:''},steps:Object.fromEntries(ORDER.map(k=>[k,{status:'draft',history:[]}])),jobs:[],vocabulary:{},commentThreads:[],idea2Open:false});
test('H67-DASH-COUNTS · retries/vocab/attestation không tăng Check; cổng ý2 và nguồn thông qua đúng',()=>{
 const s=fixture();s.jobs=[{jobRef:'g1',kind:'grade',section:'topic',tries:3,status:'failed',createdAt:10},{jobRef:'v1',kind:'vocab',ideaIndex:1,status:'completed',createdAt:20}];
 s.steps.topic.history=[{status:'revision'}];let d=dashboardProjection(s,100);assert.equal(d.checks,1);assert.equal(d.aiComments,1);assert.equal(d.filled,3);assert.equal(d.processing.topic.tries,3);assert.equal(d.stepStates.b1.available,false);
 for(const k of ORDER.slice(0,4))s.steps[k].status='passed';s.steps.x1.approval={source:'student_attested_teacher_permission',at:'2026-10-06T00:00:00Z'};
  d=dashboardProjection(s);assert.equal(d.current,null);assert.equal(d.stepStates.b2.available,false);assert.equal(d.attested,1);assert.equal(d.passed,4);
  assert.equal(d.processing.topic,undefined);assert.equal(d.state,'working');
 s.idea2Open=true;assert.equal(dashboardProjection(s).current,'b2');
});
test('H67-DASH-SUPPORT · chỉ đếm nhận xét âm liên tiếp ở bước đang mở; job cũ không kéo lỗi lên',()=>{
 const s=fixture();s.steps.topic.history=Array.from({length:9},()=>({status:'revision'}));s.steps.topic.status='revision';
 assert.equal(dashboardProjection(s).supportLevel,9);
 s.steps.topic.history.push({status:'passed'});s.steps.topic.status='passed';
 s.jobs=[{kind:'grade',section:'topic',status:'failed',createdAt:1,jobRef:'old'},{kind:'grade',section:'topic',status:'superseded',createdAt:2,jobRef:'new'}];
 const d=dashboardProjection(s);assert.equal(d.supportLevel,0);assert.deepEqual(d.processing,{});assert.equal(d.state,'working');
});
test('H67-DASH-ACTIVITY · timestamp bền sau dọn log; góp ý GV/read/retry không thành hoạt động HV',()=>{
 const before=fixture(),s=structuredClone(before);s.responses.idea1='Mới';markDashboardActivity(before,s,1000);
 assert.equal(dashboardProjection(s).activity.studentAt,1000);
 const previous=structuredClone(s);s.commentThreads=[{ref:'thread',status:'open',messages:[{ref:'t1',role:'teacher',createdAt:'2026-10-06T01:00:00Z'}]}];markDashboardActivity(previous,s,2000);
 assert.equal(dashboardProjection(s).activity.studentAt,1000);
 const old=structuredClone(s);s.commentThreads[0].messages.push({ref:'s1',role:'student',createdAt:'2026-10-06T02:00:00Z'});markDashboardActivity(old,s,3000);
 assert.ok(dashboardProjection(s).waitingReplyAt);s.commentThreads[0].status='addressed';assert.equal(dashboardProjection(s).waitingReplyAt,null);
 const legacy=fixture();assert.equal(dashboardProjection(legacy).activity.studentAt,null);
});
test('H67-DASH-SAFE · chỉ có metadata xử lý, không token/prompt/snapshot/body AI',()=>{
 const s=fixture();s.jobs=[{kind:'grade',section:'topic',status:'leased',createdAt:100,deadlineAt:500,tries:2,jobRef:'job',leaseToken:'PRIVATE',prompt:'PRIVATE',snapshot:{secret:'PRIVATE'},responseBody:'PRIVATE'}];
 const d=dashboardProjection(s,600);assert.equal(d.processing.topic.overdue,true);assert.equal(JSON.stringify(d).includes('PRIVATE'),false);
});
