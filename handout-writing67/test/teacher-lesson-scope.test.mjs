// Quyền mới của Lesson13 không tự mở quyền đọc Lesson11 hoặc đổi quyền lớp cũ.
import test from 'node:test';
import assert from 'node:assert/strict';
import {hasTeacherClass,validateTeacherRegistry} from '../src/teacher-registry.mjs';
import {createTeacher} from '../src/teacher.mjs';
test('quyền GV theo lesson chỉ mở đúng bài, caller cũ vẫn giữ quyền theo lớp',async()=>{
 const actor={email:'teacher@izone.test',displayName:'GV mẫu',subject:'verified',classes:[],lessonClasses:{lesson13:['c']}};
 const registry={clientId:'fixture.apps.googleusercontent.com',teachers:[actor]};validateTeacherRegistry(registry,['c']);
 assert.equal(hasTeacherClass(actor,'c','lesson13'),true);assert.equal(hasTeacherClass(actor,'c','lesson11'),false);assert.equal(hasTeacherClass(actor,'c'),false);
 const teacher=createTeacher({db:{},store:{read:async()=>({activity:'lesson11',classRef:'c'})},roster:async()=>[{classRef:'c',className:'Lớp thử',students:[]}],registry:()=>registry,secret:'s'.repeat(40),lessons:{lesson11:{classes:['c']},lesson13:{classes:['c']}}});
 assert.equal((await teacher.classes(actor,'lesson13')).length,1);assert.deepEqual(await teacher.classes(actor,'lesson11'),[]);
 await assert.rejects(()=>teacher.detail(actor,'old-session'),/TEACHER_FORBIDDEN/);
 actor.classes=['c'];assert.equal(hasTeacherClass(actor,'c','lesson11'),true);
 actor.lessonClasses.lesson13=['outside'];assert.throws(()=>validateTeacherRegistry(registry,['c']),/TEACHER_REGISTRY_INVALID/);
});
