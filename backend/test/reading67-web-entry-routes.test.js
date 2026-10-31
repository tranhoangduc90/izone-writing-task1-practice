import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import request from 'supertest';
import {createReading67WebRouter} from '../src/reading-listening67/web-routes.js';
import {WebGradingError} from '../src/reading-listening67/web-grader.js';
const a='11111111-1111-4111-8111-111111111111',b='22222222-2222-4222-8222-222222222222',doc='synthetic-homework-document-12345';
function fixture(){
 const calls=[],person={ownerId:a,courseId:'1293'},entry={documentId:doc,classId:'1293',studentRef:a,name:'Synthetic A',classCode:'TESTA'};
 const ownerEntry={publicPolicy:{classId:'1293',classCode:'TESTA'},resolve:async id=>{calls.push('resolve');if(id!==doc)throw new WebGradingError('HOMEWORK_ENTRY_NOT_FOUND',403);return entry;},assert:async(id,p)=>{calls.push('guard');if(id!==doc||p.ownerId!==a||p.courseId!=='1293')throw new WebGradingError('HOMEWORK_ENTRY_OWNER_MISMATCH',403);}};
 const identity={loginStudent:async p=>{calls.push('login');return {token:'synthetic',identity:p};},authorizeTeacher:async()=>calls.push('teacher'),roster:async()=>[],teacherClasses:async()=>[]};
 const store={draft:async()=>{calls.push('draft');return {revision:9,body:{answers:{x:'Private synthetic draft'}}};},history:async()=>[],archives:async()=>[],firstCompleted:async()=>null};
 const app=express();app.use('/api',createReading67WebRouter({content:{code:'fixture',version:'v1'},grader:{},store,identity,authenticate:async()=>person,ownerEntry}));
 return {app,calls,person};
}
test('Entry resolves verified document owner without reading or creating a draft',async()=>{const f=fixture();const r=await request(f.app).get('/api/entry').query({documentId:doc}).expect(200);assert.equal(r.body.entry.studentRef,a);assert.deepEqual(f.calls,['resolve']);});
test('Unknown or malformed document cannot fall back to an arbitrary learner',async()=>{const f=fixture();await request(f.app).get('/api/entry').query({documentId:'another-document-1234567890'}).expect(403);await request(f.app).get('/api/entry').query({documentId:'short'}).expect(400);assert.equal(f.calls.includes('draft'),false);});
test('Wrong selected learner is blocked before a student session is issued',async()=>{const f=fixture();await request(f.app).post('/api/student/login').set('X-Reading-Homework-Document',doc).send({classId:'1293',studentRef:b}).expect(403);assert.equal(f.calls.includes('login'),false);});
test('Correct selected learner still uses the normal membership-checked login',async()=>{const f=fixture();await request(f.app).post('/api/student/login').set('X-Reading-Homework-Document',doc).send({classId:'1293',studentRef:a}).expect(200);assert.deepEqual(f.calls,['guard','login']);});
test('A stale session for B cannot read the draft behind the link for A',async()=>{const f=fixture();f.person.ownerId=b;await request(f.app).get('/api/draft').set('X-Reading-Homework-Document',doc).expect(403);assert.equal(f.calls.includes('draft'),false);});
test('Correct session keeps the original draft unchanged',async()=>{const f=fixture();const r=await request(f.app).get('/api/draft').set('X-Reading-Homework-Document',doc).expect(200);assert.equal(r.body.revision,9);assert.equal(r.body.body.answers.x,'Private synthetic draft');});
test('Teacher authorization is independent of the student entry context',async()=>{const f=fixture();await request(f.app).get('/api/teacher/work/1293/'+a).set('X-Reading-Homework-Document','invalid-context').expect(200);assert.equal(f.calls[0],'teacher');assert.equal(f.calls.includes('guard'),false);});
test('Legacy generic student links keep the existing membership path',async()=>{const f=fixture();await request(f.app).post('/api/student/login').send({classId:'1293',studentRef:a}).expect(200);assert.deepEqual(f.calls,['login']);});
