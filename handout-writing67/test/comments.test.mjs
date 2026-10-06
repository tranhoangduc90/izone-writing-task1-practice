import test from 'node:test';
import assert from 'node:assert/strict';
import {anchorFor,contentHash,changeThread,publicThreads} from '../src/comments.mjs';
test('H67-THREAD-CAS · hai GV không đổi trạng thái từ bản trao đổi cũ, replay vẫn hợp lệ',()=>{
 const s={version:0,responses:{a1:'Nội dung A'},steps:{a1:{status:'passed'}},jobs:[]},actor={role:'teacher',key:'one',name:'GV 1'},other={role:'teacher',key:'two',name:'GV 2'};
 changeThread(s,actor,{action:'create',field:'a1',fieldHash:contentHash(s.responses.a1),body:'Cần sửa',requestId:'create'},0);
 const status={action:'status',threadRef:s.commentThreads[0].ref,status:'addressed',expectedCommentVersion:1,requestId:'close'};
 changeThread(s,actor,status,1);
 assert.throws(()=>changeThread(s,other,{...status,status:'open',requestId:'stale'},2),e=>e.status===409&&e.message==='COMMENT_VERSION_CONFLICT');
 assert.equal(s.commentThreads[0].status,'addressed');assert.equal(s.commentVersion,2);
 changeThread(s,actor,status,3);assert.equal(s.commentVersion,2);
 assert.throws(()=>changeThread(s,actor,{...status,expectedCommentVersion:undefined,requestId:'missing-version'},4),e=>e.status===409);
});
test('H67-ANCHOR · chèn chữ gắn lại duy nhất, trùng hoặc xóa giữ trích bản cũ',()=>{
 const thread={anchor:{kind:'quote',quote:'điểm đầu',start:0,end:8,sourceHash:contentHash('điểm đầu tốt')}};
 assert.equal(anchorFor(thread,'Sửa điểm đầu tốt').start,4);assert.equal(anchorFor(thread,'điểm đầu điểm đầu').detached,true);assert.equal(anchorFor(thread,'đã xóa').detached,true);
});
test('H67-THREAD · whole-field, đoạn Unicode và overlap giữ tin nhắn, không lộ authorKey',()=>{
 const s={version:0,responses:{a1:'A 😄 cần cụ thể'},steps:{a1:{status:'passed'}},jobs:[]},actor={role:'teacher',key:'private-key',name:'GV'};
 changeThread(s,actor,{action:'create',field:'a1',fieldHash:contentHash(s.responses.a1),range:{start:2,end:4},body:'Comment emoji',requestId:'emoji'},0);
 changeThread(s,actor,{action:'create',field:'a1',fieldHash:contentHash(s.responses.a1),body:'Cả phần',requestId:'field'},0);
 const result=publicThreads(s);assert.equal(result[0].quote,'😄');assert.equal(result[1].anchor.kind,'field');assert.equal(result[0].messages[0].authorKey,undefined);assert.equal(s.version,0);assert.equal(s.steps.a1.status,'passed');
});
