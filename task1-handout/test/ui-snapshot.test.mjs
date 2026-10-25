import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setup} from './helpers.mjs';

test('timeline retains the submitted five fields after a newer draft is saved',async t=>{
 const x=await setup(t);
 const first={...x.snapshot,overview:'Bản đã gửi, không phải bản đang viết'};
 const sent=await x.service.submitCheck({sessionRef:x.sessionRef,section:'overview',snapshot:first,requestId:randomUUID()});
 const saved=await x.service.sessionDetails(x.sessionRef);
 const saveResponse=await x.service.saveDraft({sessionRef:x.sessionRef,baseVersion:saved.draftVersion,requestId:randomUUID(),...x.snapshot,overview:'Nháp mới sau khi gửi'});
 assert.deepEqual(saveResponse.comments.find(c=>c.attemptRef===sent.attemptRef).snapshot,first);
 const after=await x.service.sessionDetails(x.sessionRef);
 assert.equal(after.overview,'Nháp mới sau khi gửi');
 const feedback=after.comments.find(c=>c.attemptRef===sent.attemptRef);
 assert.deepEqual(feedback.snapshot,first);
 const attempt=await x.service.getAttempt(sent.attemptRef);
 assert.deepEqual(attempt.snapshot,first);assert.deepEqual(attempt.comment.snapshot,first);
 assert.equal(feedback.attemptRef,sent.attemptRef);
});
