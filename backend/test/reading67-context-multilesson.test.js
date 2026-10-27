import test from 'node:test';
import assert from 'node:assert/strict';
import {createContextSnapshot,parseContextSnapshot} from '../src/reading-listening67/authority/context-contract.js';
import {createContext} from '../src/reading-listening67/authority/context.js';
import {createReading67WebIdentity} from '../src/reading-listening67/web-identity.js';
test('Nguồn lớp mới vẫn kiểm hash/schema; quyền bài chỉ mở đúng allowlist, kể cả lớp chưa có roster',async()=>{
 const payload={apiVersion:1,productId:'PRODUCT-TERM-MINI-K67',classes:[{erp_course_class_id:'1193',erp_class_name_snapshot:'TEST-A',erp_course_id:'5'},{erp_course_class_id:'1370',erp_class_name_snapshot:'TEST-B',erp_course_id:'5'}],students:[],memberships:[],accounts:[],access:[]};
 assert.throws(()=>createContextSnapshot(payload),e=>e.code==='CONTEXT_OUTSIDE_SCOPE');
 const snapshot=createContextSnapshot(payload,Date.now(),{allowDiscoveredClasses:true});
 assert.deepEqual(parseContextSnapshot(snapshot,Date.now(),{allowDiscoveredClasses:true}).classes,payload.classes);
 const broken=structuredClone(snapshot);broken.classes[0].erp_course_id='6';assert.throws(()=>parseContextSnapshot(broken,Date.now(),{allowDiscoveredClasses:true}),e=>e.code==='CONTEXT_REVISION_MISMATCH');
 const unknown=structuredClone(payload);unknown.classes[0].access_all=true;assert.throws(()=>createContextSnapshot(unknown,Date.now(),{allowDiscoveredClasses:true}));
 const context=createContext({url:'http://fixture',key:'fixture',allowDiscoveredClasses:true,fetcher:async()=>new Response(JSON.stringify(snapshot))});
 const identity=createReading67WebIdentity({db:{},context,allowedClassIds:['1193'],includeEmptyClasses:true});
 assert.deepEqual(await identity.classes(),[{id:'1193',classCode:'TEST-A'}]);
 await assert.rejects(identity.roster('1370'),e=>e.code==='ACCESS_DENIED');
 await assert.rejects(identity.loginStudent({classId:'1370',studentRef:'11111111-1111-4111-8111-111111111111'}),e=>e.code==='ACCESS_DENIED');
});
