import test from 'node:test';
import assert from 'node:assert/strict';
import {createLesson9VocabularyService,vocabularyHash,normalizeVocabulary} from './lesson9-vocabulary.js';
import {requireLesson} from './lesson-config.mjs';
const vocabulary=['A1','X1','B1','A2','X2','B2'].map(point=>({point,terms:[{phrase:'test phrase',meaningVi:'nghĩa thử'}]}));
for(const slug of ['writing-task2-public-health-ban','writing-task2-public-health-spending'])test('từ vựng nhận đúng đề '+slug,async()=>{
 const responses={topic_sentence:'Fixture',idea1_a:'Input A'},job={public_id:crypto.randomUUID(),session_id:1,lease_token:crypto.randomUUID(),snapshot:responses,snapshot_hash:vocabularyHash(responses)};
 let prompt='',completed;
 const client={release(){},async query(sql,params){
  if(sql.includes('WITH picked'))return {rows:[job]};
  if(sql.includes('SELECT a.slug'))return {rows:[{slug}]};
  if(sql.includes('SELECT response_data'))return {rows:[{response_data:responses}],rowCount:1};
  if(sql.includes('SET status=$3'))completed=params[2];return {rows:[],rowCount:1};
 }};
 const service=createLesson9VocabularyService({pool:{connect:async()=>client,query:client.query},fetchImpl:async(_url,options)=>{prompt=JSON.parse(options.body).prompt;return {ok:true,json:async()=>({output:JSON.stringify(vocabulary)})};}});
 await service.tick();assert.equal(completed,'completed');assert.ok(prompt.includes(requireLesson(slug).statement));
 const other=slug.endsWith('-ban')?'writing-task2-public-health-spending':'writing-task2-public-health-ban';assert.ok(!prompt.includes(requireLesson(other).statement));
});
test('từ vựng từ chối point trùng thay vì ghép theo vị trí',()=>assert.throws(()=>normalizeVocabulary([...vocabulary.slice(0,5),vocabulary[0]]),/IDENTITY/));
test('không chọn đề lạ hoặc đề chưa mở preview',()=>{
 assert.throws(()=>requireLesson('unknown'),/Đề/);assert.throws(()=>requireLesson('writing-task2-english-medium-instruction'),/Đề/);
});
