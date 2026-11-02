// Cùng một request nguồn vẫn trả đúng roster từng lesson; không dùng người cũ để lấp nguồn mới thiếu.
import test from 'node:test';
import assert from 'node:assert/strict';
import {rosterAdapter} from '../src/config.mjs';
test('roster lesson-scoped giữ nguyên bài cũ và gom request nguồn đang chờ',async()=>{
 let done,calls=0;const wait=new Promise(r=>done=r),row=(ref)=>({classRef:'c',className:'Lớp thử',students:[{studentRef:ref,displayName:ref}]}),source={ok:true,classes:[row('legacy')],lessonClasses:{lesson13:[row('approved')]}};
 const get=rosterAdapter({rosterUrl:'https://source.invalid',classes:['c']},async()=>{calls++;await wait;return {ok:true,json:async()=>structuredClone(source)};});
 const before=structuredClone(source),old=get('lesson11'),fresh=get('lesson13','lesson');done();
 assert.equal((await old)[0].students[0].studentRef,'legacy');assert.equal((await fresh)[0].students[0].studentRef,'approved');assert.equal(calls,1);assert.deepEqual(source,before);
 await assert.rejects(()=>get('lesson99','lesson'),/ROSTER_CONTRACT_INVALID/);assert.equal(calls,2);
});
