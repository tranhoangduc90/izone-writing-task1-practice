// Kiểm HTTP/SQL thật với bài giả: biên nhận gọn không đổi bản lưu hoặc retry.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import express from 'express';
import request from 'supertest';
import {PGlite} from '@electric-sql/pglite';
import {createReading67WebStore} from '../src/reading-listening67/web-store.js';
import {createReading67WebRouter} from '../src/reading-listening67/web-routes.js';

async function fixture(t){
 const db=new PGlite();await db.exec(await fs.readFile(new URL('../ops/listening-homework67/schema.sql',import.meta.url),'utf8'));t.after(()=>db.close());
 const content={code:'ack-fixture',version:'v1'},person={ownerId:randomUUID(),courseId:'1293'},scope={...person,...content};
 const grader={inspectWeb:answers=>({completeness:{filled_cells:Object.keys(answers).length,eligible_for_grading:false}})};
 const store=createReading67WebStore({db,grader}),app=express();app.use('/api',createReading67WebRouter({store,content,grader,authenticate:q=>q.headers['x-fixture-person']==='A'?person:null}));
 const body={answers:{one:'Nội dung trả lời '.repeat(400)},notes:'Ghi chú đủ dấu.\n'.repeat(600),annotations:[{quote:'câu được chọn',note:'ghi chú riêng'}],flags:[1]};
 const input={baseRevision:0,mutationId:randomUUID(),body};return {app,store,scope,input};
}

test('Compact ACK removes the echoed body but preserves durable draft, metadata and legacy retry response',async t=>{
 const {app,store,scope,input}=await fixture(t);
 const compact=await request(app).put('/api/draft?ack=compact-v1').set('x-fixture-person','A').send(input).expect(200);
 assert.equal(compact.body.responseFormat,'draft-ack-v1');assert.equal(compact.body.body,undefined);assert.equal(compact.body.revision,1);assert.equal(compact.body.runNo,1);assert.ok(compact.body.savedAt);assert.equal(compact.body.completeness.filled_cells,1);
 const full=await request(app).put('/api/draft').set('x-fixture-person','A').send(input).expect(200);
 assert.deepEqual(full.body.body,input.body);assert.equal(full.body.revision,compact.body.revision);assert.equal(full.body.savedAt,compact.body.savedAt);
 const repeat=await request(app).put('/api/draft?ack=compact-v1').set('x-fixture-person','A').send(input).expect(200);assert.deepEqual(repeat.body,compact.body);
 assert.deepEqual((await store.draft(scope)).body,input.body);
 const read=await request(app).get('/api/draft?ack=compact-v1').set('x-fixture-person','A').expect(200);assert.deepEqual(read.body.body,input.body);
 assert.ok(Buffer.byteLength(JSON.stringify(compact.body))<Buffer.byteLength(JSON.stringify(full.body))*.05);
});

test('Legacy saves and unknown formats keep their response; compact saves retain authorization and mutation conflicts',async t=>{
 const {app,store,scope,input}=await fixture(t);
 await request(app).put('/api/draft?ack=compact-v1').send(input).expect(401);
 const full=await request(app).put('/api/draft?ack=unknown').set('x-fixture-person','A').send(input).expect(200);assert.deepEqual(full.body.body,input.body);assert.equal(full.body.responseFormat,undefined);
 const wrong={...input,body:{...input.body,notes:'Nội dung khác'}};
 const conflict=await request(app).put('/api/draft?ack=compact-v1').set('x-fixture-person','A').send(wrong).expect(409);assert.equal(conflict.body.error,'MUTATION_ID_REUSED');
 assert.deepEqual((await store.draft(scope)).body,input.body);assert.equal((await store.draft(scope)).revision,1);
});
