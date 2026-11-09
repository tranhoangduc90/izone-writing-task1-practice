import assert from 'node:assert/strict';
import {test} from 'node:test';
import {outlineRelation,workflowFor,available} from '../src/workflow.mjs';

const passed=direction=>({status:'passed',direction});
const session=(stance,first,second)=>({outlineOnly:true,responses:{stance},steps:{body1_topic:first,body2_topic:second}});

test('Lesson 3 chỉ chấm hai thân và thân 2 mở ngay cả khi thân 1 trống',()=>{
 const state=session('disagree',{status:'draft'},{status:'draft'});
 assert.deepEqual(workflowFor(state).order,['body1_topic','body2_topic']);
 assert.equal(available(state,'body2_topic'),true);
 assert.equal(available(state,'body2_si1'),false);
 assert.equal(outlineRelation(state),'waiting');
});

test('Đối chiếu phân biệt hướng, thứ tự, cân bằng và bản chưa đạt',()=>{
 const agree=passed('agree'),disagree=passed('disagree'),balanced=passed('balanced');
 for(const [stance,first,second,expected] of [
  ['disagree',disagree,agree,'order'],['agree',agree,disagree,'order'],
  ['disagree',agree,disagree,'passed'],['agree',disagree,agree,'passed'],
  ['disagree',agree,agree,'stance'],['agree',agree,agree,'passed'],
  ['balanced',disagree,agree,'passed'],['balanced',agree,disagree,'passed'],
  ['balanced',balanced,balanced,'passed'],['disagree',balanced,disagree,'passed'],
  ['agree',balanced,disagree,'stance'],['disagree',agree,{status:'revision',direction:'disagree'},'waiting'],
  ['',agree,disagree,'waiting']
 ])assert.equal(outlineRelation(session(stance,first,second)),expected);
});
