// HTTP và SQL đọc phiên Writing thật, 100 người giả; so snapshot live trước/sau delta.
// Không mở/nộp bài thật, không chấm AI; PostgreSQL nhúng không đại diện tài nguyên VPS.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
const baseline=process.env.WRITING_OWNER_BASELINE,candidate=process.env.WRITING_OWNER_RUNTIME,out=process.env.WRITING_OWNER_LOAD_OUTPUT;
test('100 người đọc phiên Task1/Task2/Lesson13 và hỗn hợp: đúng chủ/nháp, so trước và sau', async()=>{
  assert.ok(baseline&&candidate&&out,'Cần source live trước/sau và file kết quả riêng.');
  const db=new PGlite(),servers=[],metrics=[];
  const origin='https://tranhoangduc90.github.io';
  const uuid=(prefix,n)=>`${prefix}-1111-4111-8111-${String(n).padStart(12,'0')}`;
  const people=Array.from({length:100},(_,i)=>({student:uuid('11111111',i+1),session:uuid('aaaaaaaa',i+1),
    classRef:uuid('bbbbbbbb',1+Math.floor(i/25)),classId:1+Math.floor(i/25),n:i+1}));
  let outcome='partial';
  try{
    await db.exec(`CREATE SCHEMA writing_practice;
      CREATE TABLE writing_practice.activity(id bigint PRIMARY KEY,slug text,title text);
      CREATE TABLE writing_practice.activity_class_scope(id bigint PRIMARY KEY,public_id uuid);
      CREATE TABLE writing_practice.activity_session(id bigint PRIMARY KEY,public_id uuid UNIQUE,activity_id bigint,activity_class_id bigint,
        student_public_id uuid,overview text,body1 text,body2 text,draft1 text,draft2 text,draft2_unlocked boolean,
        draft_version int,updated_at timestamptz,response_data jsonb);
      CREATE TABLE writing_practice.session_section(session_id bigint,section_key text,locked boolean,fail_streak int,round_number int);
      CREATE TABLE writing_practice.comment(public_id uuid,attempt_id uuid,session_id bigint,section_key text,comment_number int,status text,content text,created_at timestamptz);
      CREATE TABLE writing_practice.check_attempt(id uuid,public_id uuid,session_id bigint,section_key text,comment_number int,status text,
        result_status text,error_code text,result_artifacts jsonb,retry_count int,created_at timestamptz,completed_at timestamptz);
      CREATE TABLE writing_practice.activity_section_definition(activity_id bigint,section_key text,title text,sort_order int,
        input_fields jsonb,context_fields jsonb,required_fields jsonb,validation_mode text,prerequisite_sections jsonb);
      INSERT INTO writing_practice.activity VALUES(1,'fixture-task','Bài giả');`);
    for(const p of people.filter((_,i)=>i%25===0))await db.query('INSERT INTO writing_practice.activity_class_scope VALUES($1,$2)',[p.classId,p.classRef]);
    for(const p of people)await db.query(`INSERT INTO writing_practice.activity_session VALUES($1,$2,1,$3,$4,$5,'','','','',false,7,now(),$6)`,
      [p.n,p.session,p.classId,p.student,'Nháp '+p.n,JSON.stringify({topic_sentence:'Ý '+p.n})]);
    const pool={query:async(sql,args)=>{assert.doesNotMatch(sql,/\b(INSERT|UPDATE|DELETE|ALTER|TRUNCATE)\b/i);
      const result=await db.query(sql,args);return{...result,rowCount:result.rows.length};}};
    const ports={};
    for(const [label,root] of [['before',baseline],['after',candidate]]){
      const base=pathToFileURL(path.resolve(root,'src')+path.sep);
      const {createApp}=await import(new URL('app.js',base));
      const {createWritingPracticeService}=await import(new URL('service.js',base));
      const {createLessonPracticeService}=await import(new URL('lesson-service.js',base));
      const app=createApp({config:{allowedOrigins:new Set([origin]),trustProxyHops:1,internalApiToken:'fixture-only'},pool,
        service:createWritingPracticeService({pool}),lessonService:createLessonPracticeService({pool})});
      const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
      servers.push(server);ports[label]=server.address().port;
    }
    function request(label,kind,p){return new Promise((resolve,reject)=>{
      const prefix=kind==='task1'?'sessions':'lesson-sessions',start=performance.now();
      const req=http.get({hostname:'127.0.0.1',port:ports[label],path:`/api/v1/${prefix}/${p.session}`,
        headers:{Origin:origin,'X-Forwarded-For':'192.0.2.'+p.classId}},res=>{
        const chunks=[];res.on('data',value=>chunks.push(value));res.on('end',()=>{
          try{const data=JSON.parse(Buffer.concat(chunks));assert.equal(res.statusCode,200,JSON.stringify(data));
            const session=data.session;assert.equal(session.sessionRef,p.session);assert.equal(session.draftVersion,7);
            if(kind==='task1')assert.equal(session.overview,'Nháp '+p.n);else assert.equal(session.responses.topic_sentence,'Ý '+p.n);
            if(label==='after')assert.deepEqual([session.studentRef,session.classRef,session.activitySlug],[p.student,p.classRef,'fixture-task']);
            resolve(performance.now()-start);
          }catch(error){reject(error);}
        });
      });req.on('error',reject);req.setTimeout(15000,()=>req.destroy(new Error('LOCAL_HTTP_TIMEOUT')));
    });}
    // Warmup cả hai trước đo; không dùng thời gian khởi tạo WASM làm thời gian mở bài.
    await request('before','task1',people[0]);await request('after','task1',people[0]);
    for(const kind of ['task1','task2','lesson13','mixed'])for(const label of ['before','after']){
      const values=await Promise.all(people.map((p,i)=>request(label,kind==='mixed'?(i%3?'lesson13':'task1'):kind,p)));
      values.sort((a,b)=>a-b);const record={kind,label,users:100,maxUsersPerIp:25,success:100,
        medianMs:Math.round(values[49]),p95Ms:Math.round(values[94]),maxMs:Math.round(values[99])};
      metrics.push(record);console.log(JSON.stringify(record));
    }
    assert.deepEqual((await db.query('SELECT count(*)::int AS n FROM writing_practice.activity_session')).rows,[{n:100}]);
    outcome='passed';
  }finally{
    for(const server of servers)await new Promise(resolve=>server.close(resolve));await db.close();
    await writeFile(out,JSON.stringify({outcome,metrics,scope:'existing-session-read-only',productionRequests:0,
      limits:['Embedded PostgreSQL, 100 synthetic sessions; no real VPS capacity conclusion.',
        'No session creation, editing, submission, AI, Docs or Portal load.',
        'Single before/after run describes these samples; not a statistical speedup claim.']},null,2),'utf8');
  }
});
