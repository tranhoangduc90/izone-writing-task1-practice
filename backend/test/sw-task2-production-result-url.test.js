import test from 'node:test';
import assert from 'node:assert/strict';
import {createWritingPracticeService} from '../ops/sw-task2-production/service-runtime.js';
const id='a'.repeat(48);
const boundary=new Error('TEST_DATABASE_BOUNDARY');
const service=createWritingPracticeService({pool:{connect:async()=>{throw boundary;}}});
const complete=lmsUrl=>service.completeJob({jobRef:'11111111-1111-4111-8111-111111111111',leaseToken:'22222222-2222-4222-8222-222222222222',resultStatus:'passed',feedback:'Verified synthetic result',artifacts:{lmsUrl}});
test('SW nhận kết quả đúng tuyến Shops chính thức trước khi ghi database',async()=>{
 await assert.rejects(complete(`https://ducizone.ddns.net/shops-writing-api/results/shared/writing-essays/${id}/view?v=1`),error=>error===boundary);
});
test('SW từ chối kết quả preview, sai host/credential/phiên bản/query',async()=>{
 for(const url of [
  `https://ducizone.ddns.net/sw-task2-preview-api/results/shared/writing-essays/${id}/view?v=1`,
  `https://example.invalid/shops-writing-api/results/shared/writing-essays/${id}/view?v=1`,
  `https://user@ducizone.ddns.net/shops-writing-api/results/shared/writing-essays/${id}/view?v=1`,
  `https://ducizone.ddns.net/shops-writing-api/results/shared/writing-essays/${id}/view?v=0`,
  `https://ducizone.ddns.net/shops-writing-api/results/shared/writing-essays/${id}/view?v=1&other=1`,
 ])await assert.rejects(complete(url),error=>error.code==='INVALID_LMS_URL');
});
