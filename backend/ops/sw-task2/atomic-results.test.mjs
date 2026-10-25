import {test} from 'node:test';import assert from 'node:assert/strict';
import {createShopsResults} from './atomic-results.mjs';
const id='a'.repeat(48),engines=[['sw-task2-writing56-67-preview-20261025.1','sw-task2-preview-api'],['shops-writing56-67-production-20261024.1','shops-writing-api']];
function setup(engine,prefix,change={},rawChange={}){
 const artifacts={gradingEngine:engine,writerGroupId:id,writerVersion:2,readbackOk:true,correctionsCount:0,noCorrections:true,lmsUrl:`https://ducizone.ddns.net/${prefix}/results/shared/writing-essays/${id}/view?v=2`,...change};
 let fetched=[];const service=createShopsResults({pool:{query:async()=>({rowCount:1,rows:[{artifacts,updatedAt:'2026-10-25T00:00:00Z'}]})},fetchImpl:async url=>{fetched.push(url);return new Response(JSON.stringify({meta:{id,version:2},essays:[],...rawChange}),{headers:{'Content-Type':'application/json'}});}});
 return {service,fetched};
}
for(const [engine,prefix] of engines)test('preserve pinned native result: '+engine,async()=>{const {service,fetched}=setup(engine,prefix);const value=await service.getDraftResult({sessionRef:'fixture'});assert.equal(value.noCorrections,true);assert.equal(value.readbackOk,true);assert.deepEqual(fetched,[`http://sw-task2-preview-writer:8780/writing-data/${id}/v000002.json`]);});
for(const change of [{lmsUrl:'https://untrusted.invalid/result'},{writerVersion:3},{readbackOk:false},{writerGroupId:'../other'}])test('reject changed binding '+JSON.stringify(change),async()=>{const {service,fetched}=setup(...engines[1],change);await assert.rejects(service.getDraftResult({sessionRef:'fixture'}),e=>e.code==='SHOPS_RESULT_BINDING');assert.equal(fetched.length,0);});
test('reject historical snapshot changed on disk',async()=>{const {service}=setup(...engines[1],{},{meta:{id,version:1}});await assert.rejects(service.getDraftResult({sessionRef:'fixture'}),e=>e.code==='SHOPS_RESULT_CHANGED');});
