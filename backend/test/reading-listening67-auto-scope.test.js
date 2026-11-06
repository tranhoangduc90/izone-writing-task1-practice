import test from 'node:test';
import assert from 'node:assert/strict';
import {createCourse67Scope} from '../src/reading-listening67/web-course67-scope.js';
import {createReading67WebIdentity} from '../src/reading-listening67/web-identity.js';
import {createReading67OwnerSource} from '../src/reading-listening67/web-owner-source.js';
import {createReading67OwnerEntry} from '../src/reading-listening67/web-owner-entry.js';
import {sha256} from '../src/reading-listening67/web-grader.js';
const ref='11111111-1111-4111-8111-111111111111';
function harness(){
 let now=Date.parse('2026-11-06T05:00:00Z'),rows=[],calls=0,invalid=false;
 const clock=()=>now,scope=createCourse67Scope({url:'https://authority.test',key:'private',clock,fetcher:async()=>{calls++;const p={apiVersion:1,erpCourseId:'5',classes:rows};return Response.json({...p,capturedAt:new Date(now).toISOString(),sourceRevision:invalid?'bad':sha256(JSON.stringify(p))});}});
 const data={classes:[{erp_course_class_id:'101',erp_course_id:'5',erp_class_name_snapshot:'OLD'},{erp_course_class_id:'202',erp_course_id:'5',erp_class_name_snapshot:'NEW'},{erp_course_class_id:'303',erp_course_id:'4',erp_class_name_snapshot:'OTHER'}],students:[{public_id:ref,erp_course_class_id:'202',erp_student_contact_id:'22',erp_student_name_snapshot:'Synthetic',status:'approved'}],memberships:[{erp_course_class_id:'202',erp_student_contact_id:'22',source_state:'active'}],accounts:[],access:[]};
 const context={classScope:scope,snapshot:async()=>data,classes:async()=>data.classes.map(c=>({id:c.erp_course_class_id,classCode:c.erp_class_name_snapshot})),roster:async id=>data.students.filter(s=>s.erp_course_class_id===id&&s.status==='approved'&&data.memberships.some(m=>m.erp_course_class_id===id&&m.source_state==='active')).map(s=>({studentRef:s.public_id,name:s.erp_student_name_snapshot}))};
 const identity=createReading67WebIdentity({db:{},context,allowedClassIds:['101'],includeEmptyClasses:true});
 return {scope,context,data,identity,clock,calls:()=>calls,advance:()=>{now+=31000;},open:()=>{rows=[{classId:'202',classCode:'NEW',courseId:'google-new'}];},invalid:()=>{invalid=true;}};
}
test('class added after construction appears without restart; concurrent lessons share one source fetch',async()=>{
 const h=harness();assert.deepEqual(await h.identity.classes(),[{id:'101',classCode:'OLD'}]);
 await assert.rejects(h.identity.member('202',ref),{code:'ACCESS_DENIED'});
 h.open();h.advance();
 const identities=Array.from({length:11},()=>createReading67WebIdentity({db:{},context:h.context,allowedClassIds:['101'],includeEmptyClasses:true}));
 const lists=await Promise.all(identities.map(i=>i.classes()));assert.ok(lists.every(x=>x.some(c=>c.id==='202')));assert.equal(h.calls(),2);
 assert.equal((await h.identity.member('202',ref)).name,'Synthetic');
 assert.deepEqual((await h.identity.classes()).map(c=>c.id).sort(),['101','202']);
 await assert.rejects(h.identity.member('303',ref),{code:'ACCESS_DENIED'});
});
test('pending student and inactive membership remain denied; explicit lesson opt-out stays narrow',async()=>{
 const h=harness();h.open();h.data.students[0].status='pending';await assert.rejects(h.identity.member('202',ref),{code:'STUDENT_ACCESS_DENIED'});
 h.data.students[0].status='approved';h.data.memberships[0].source_state='inactive';await assert.rejects(h.identity.member('202',ref),{code:'STUDENT_ACCESS_DENIED'});
 const narrow=createReading67WebIdentity({db:{},context:h.context,allowedClassIds:['101'],classScope:null});await assert.rejects(narrow.member('202',ref),{code:'ACCESS_DENIED'});
});
test('source error after cache expiry fails closed; it is not treated as empty roster',async()=>{
 const h=harness();h.open();await h.identity.classes();h.invalid();h.advance();await assert.rejects(h.identity.roster('202'),{code:'COURSE67_SCOPE_UNAVAILABLE',status:503});
});
test('Listening context expands before filtering, including a direct new-class request',async t=>{
 let createListeningContext;try{({createListeningContext}=await import('../src/listening-homework67/context.js'));}catch(e){if(e.code==='ERR_MODULE_NOT_FOUND'){t.skip('Reading-only image has no Listening context');return;}throw e;}
 const h=harness();const context=createListeningContext({url:'https://authority.test',key:'x',allowedClassIds:['101'],classScope:h.scope,clock:h.clock,fetcher:async()=>{const p={apiVersion:1,productId:'PRODUCT-TERM-MINI-K67',...h.data};return Response.json({...p,capturedAt:new Date(h.clock()).toISOString(),sourceRevision:sha256(JSON.stringify(p))});}});
 assert.equal((await context.classes()).length,1);h.open();h.advance();assert.equal((await context.roster('202')).length,1);assert.deepEqual((await context.classes()).map(c=>c.id),['202','101']);
});
test('new-class owner lookup still verifies approved UUID, Google owner and course',async()=>{
 const h=harness();h.open();const owner=createReading67OwnerSource({context:h.context,allowedClassIds:['101'],url:'https://owner.test',key:'x',clock:h.clock,fetcher:async()=>{const p={apiVersion:1,classId:'202',studentRef:ref,courseId:'google-new',googleUserId:'google-user'};return Response.json({...p,capturedAt:new Date(h.clock()).toISOString(),sourceRevision:sha256(JSON.stringify(p))});}});
 assert.equal((await owner.member('202',ref)).courseId,'google-new');assert.equal((await owner.resolveClassroom({courseId:'google-new',googleUserId:'google-user'})).studentRef,ref);
});
for(const code of ['reading-materials','reading-butterflies','reading-green','reading-desolenator','reading-athletes','reading-people','listening-scandinavian','listening-03','listening-04','listening-05','listening-06'])test(code+': first document entry refreshes policy and preserves owner checks',async()=>{
 const h=harness();const metadata={code,version:'v1'},target={classId:'202',studentRef:ref,...metadata,courseId:'google-new',googleUserId:'google-user',courseWorkId:'work',submissionId:'submission',documentId:'synthetic-long-document-id',tabId:'t.0'};
 const db={query:async()=>({rows:[{owner_id:ref,course_id:'202',assignment_code:code,content_version:'v1',target}]})};
 const entry=createReading67OwnerEntry({db,identity:h.identity,metadata,policy:{classes:[{classId:'101',classCode:'OLD',courseId:'google-old'}]}});
 assert.equal(entry.publicPolicy.classes.length,1);h.open();h.advance();assert.equal((await entry.resolve(target.documentId)).classCode,'NEW');assert.equal(entry.publicPolicy.classes.length,2);
 await assert.rejects(entry.assert(target.documentId,{ownerId:'other',courseId:'202'}),{code:'HOMEWORK_ENTRY_OWNER_MISMATCH'});
 target.courseId='wrong';await assert.rejects(entry.resolve(target.documentId),{code:'HOMEWORK_ENTRY_NOT_FOUND'});
});

for(const kind of ['wrong-course','stale','future','duplicate-class','duplicate-course','hash','http'])test('invalid metadata '+kind+' cannot expand scope',async()=>{
 const now=Date.parse('2026-11-06T05:00:00Z'),p={apiVersion:1,erpCourseId:'5',classes:[{classId:'202',classCode:'NEW',courseId:'google-new'}]};let age=0;
 if(kind==='wrong-course')p.erpCourseId='4';if(kind==='stale')age=-120001;if(kind==='future')age=6000;
 if(kind==='duplicate-class')p.classes.push({...p.classes[0],courseId:'another'});if(kind==='duplicate-course')p.classes.push({...p.classes[0],classId:'303',classCode:'ANOTHER'});
 const scope=createCourse67Scope({url:'https://source.test',key:'private',clock:()=>now,fetcher:async()=>Response.json({...p,capturedAt:new Date(now+age).toISOString(),sourceRevision:kind==='hash'?'0'.repeat(64):sha256(JSON.stringify(p))},{status:kind==='http'?503:200})});
 await assert.rejects(scope.allowed(['101']),{code:'COURSE67_SCOPE_UNAVAILABLE',status:503});
});
