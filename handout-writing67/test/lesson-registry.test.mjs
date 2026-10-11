// Nhận registry giả ngoài repo: kiểm không lộ rubric và không dùng nhầm đề/phiên bản.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {promptRenderer} from '../src/prompt.mjs';
import {publicLesson} from '../src/lessons.mjs';

test('H67-REGISTRY · cấu hình công khai không chứa rubric; chặn nhầm lesson/version/topic và lớp ngoài quyền',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'handout67-registry-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const file=join(dir,'lessons.json'),entries={};
 for(const number of [5,7]){const activity='lesson'+number;entries[activity]={definition:{activity,number,body:2,title:'Bài '+number,shortTitle:'Đề '+number,topic:'Question '+number,aInstruction:'Hướng dẫn A',ideaHint:'Hướng dẫn ý',classes:['IC2304'],defaultClass:'IC2304'},version:activity+'-rubric-v1',rubrics:Object.fromEntries(['topic','b1','b2','a','x','vocab'].map(k=>[k,'PRIVATE '+activity+' '+k]))};}
 await writeFile(file,JSON.stringify({version:'handout67-lessons-v1',lessons:entries}));
 const render=await promptRenderer(file,{classes:['IC2304']});
 for(const number of [5,7]){
  const activity='lesson'+number,job={kind:'grade',section:'a2',ideaIndex:2,promptVersion:activity+'-rubric-v1',snapshot:{activity,topic:'Question '+number,responses:{a1:'Wrong idea',a2:'Correct A2',b2:'Approved B2',idea2:'Idea 2',topicSentence:'Topic'},history:[{feedback:'A2 history'}]}};
  const p=render(job);assert.match(p,new RegExp('PRIVATE '+activity+' a'));assert.match(p,/Correct A2/);assert.match(p,/Approved B2/);assert.match(p,/A2 history/);assert.ok(!p.includes('Wrong idea'));
  assert.ok(!JSON.stringify(publicLesson(render.lessons[activity])).includes('PRIVATE'));
  assert.throws(()=>render({...job,promptVersion:'lesson99-rubric-v1'}),/PROMPT_LESSON_MISMATCH/);
  assert.throws(()=>render({...job,snapshot:{...job.snapshot,topic:'Wrong question'}}),/PROMPT_LESSON_MISMATCH/);
  assert.throws(()=>render({...job,snapshot:{...job.snapshot,activity:number===5?'lesson7':'lesson5'}}),/PROMPT_LESSON_MISMATCH/);
 }
 await assert.rejects(()=>promptRenderer(file,{classes:['OTHER']}),/LESSON_CLASS_OUT_OF_SCOPE/);
 entries.lesson7.rubrics.a='';await writeFile(file,JSON.stringify({version:'handout67-lessons-v1',lessons:entries}));await assert.rejects(()=>promptRenderer(file),/PROMPT_REGISTRY_INVALID/);
});
