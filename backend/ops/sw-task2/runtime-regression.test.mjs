import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
const modulePath=process.env.SW_RUNTIME_TEST_FILE||new URL('./service-runtime.js',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1');
const {createWritingPracticeService}=await import(pathToFileURL(modulePath));
import {ApiError} from '../../src/service.js';
import lessons from './lessons.json' with {type:'json'};
const cases=Object.values(lessons).map(l=>[l.slug,l.statement]);
for(const [slug,prompt] of cases)test('claim giữ đúng ngữ cảnh đã ghim: '+slug,async()=>{
 const row={public_id:crypto.randomUUID(),section_key:'topic_sentence',comment_number:1,snapshot:{topic_sentence:'Fixture'},lease_token:crypto.randomUUID(),lease_expires_at:'2026-10-25T02:00:00Z',grading_context:{activitySlug:slug,taskPrompt:prompt,promptRegistryKey:'own-preview-key',promptRecordId:'sw-task2:'+slug+':lesson9-v1',promptVersion:'2026-10-25.1',feedbackHistory:[]}};
 const client={query:async sql=>sql.includes('WITH picked')?{rows:[row]}:{rows:[]},release(){}};
 const pool={connect:async()=>client};
 const [job]=await createWritingPracticeService({pool}).claimJobs({workerId:'fixture',workerPool:'task2',maxJobs:1,leaseSeconds:420});
 assert.equal(job.activitySlug,slug);assert.equal(job.taskPrompt,prompt);assert.equal(job.attemptRef,row.public_id);assert.equal(job.leaseToken,row.lease_token);assert.equal(job.promptVersion,'2026-10-25.1');
});
test('lỗi nghiệp vụ của bộ SW giữ cùng kiểu lỗi với HTTP router',async()=>{
 const service=createWritingPracticeService({pool:{connect:async()=>{throw Error('Must fail before DB');}}});
 await assert.rejects(service.completeJob({jobRef:crypto.randomUUID(),leaseToken:crypto.randomUUID(),resultStatus:'passed',feedback:'fixture',artifacts:{lmsUrl:'https://forged.invalid/result'}}),e=>e instanceof ApiError&&e.status===400);
});
