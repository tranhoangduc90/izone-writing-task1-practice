// Exercise the real process over HTTP; every identity, lesson and answer is synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomUUID} from 'node:crypto';
import net from 'node:net';

const backend=fileURLToPath(new URL('../',import.meta.url));
const entry=process.env.LISTENING_ENTRYPOINT_UNDER_TEST||path.join(backend,'scripts/serve-listening-homework67.mjs');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const ids=['U1','U2','U3'];
const lesson={code:'67-listening-process-fixture',version:'fixture-v1',title:'Synthetic listening process',homeworkLesson:2,minimumCompletion:.8,audioId:'synthetic-audio',groups:[],questions:[],items:ids.map(id=>({id,group:'fixture',question:'Synthetic '+id,answer:'approved '+id,core:'Meaning '+id,accept:'Valid variants are open',reject:'Contradiction must be rejected',units:[{id:id+'.u1',meaning:'first'},{id:id+'.u2',meaning:'second'}]}))};
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('Actual Listening process: canary worker switch, durable queue/restart, compatible receipts and native permissions',{timeout:35000},async t=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'listening-process-'));
 const reservation=net.createServer();reservation.listen(0,'127.0.0.1');await once(reservation,'listening');const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));
 const base='http://127.0.0.1:'+port+'/api/listening-homework67';
 const payload={apiVersion:1,productId:'PRODUCT-TERM-MINI-K67',classes:[{erp_course_class_id:'1293',erp_class_name_snapshot:'IC-FIXTURE',erp_course_id:'5'}],students:[A,B].map((public_id,n)=>({public_id,erp_course_class_id:'1293',erp_student_contact_id:String(n+91),erp_student_name_snapshot:'Synthetic '+n,status:'approved'})),memberships:[91,92].map(id=>({erp_course_class_id:'1293',erp_student_contact_id:String(id),source_state:'active'})),accounts:[{email:'teacher@example.test',google_subject:'fixture-google',display_name:'Synthetic teacher',role:'teacher',status:'active',can_access_all_classes:false}],access:[{reviewer_email:'teacher@example.test',erp_course_class_id:'1293'}]};
 for(const [name,value] of Object.entries({'lesson.json':lesson,'audio.json':{id:lesson.audioId,url:'http://127.0.0.1:9/never-download'},'authority.json':payload}))await fs.writeFile(path.join(tmp,name),JSON.stringify(value));
 const config={mode:'local_fixture',port,lessonPath:path.join(tmp,'lesson.json'),audioPath:path.join(tmp,'audio.json'),dataDir:path.join(tmp,'db'),authority:{path:path.join(tmp,'authority.json')},allowedClassIds:['1293'],origins:[],googleClientId:'synthetic.apps.googleusercontent.com',studentsOpen:true,ai:{model:'gemini-3.8-flash',endpoint:'http://127.0.0.1:9/never-call'},pagesPath:tmp,workersEnabled:false};
 const children=[];
 // Windows kill(SIGTERM) terminates the process unconditionally. Deliver the same
 // registered application event over fixture-only IPC there; Linux uses OS signals.
 async function stop(child){if(child.exitCode!==null||child.signalCode!==null)return;const exited=once(child,'exit');if(process.platform==='win32'){child.send('fixture:stop');child.send('fixture:stop');}else{child.kill('SIGTERM');child.kill('SIGTERM');}await Promise.race([exited,wait(5000).then(()=>{throw Error('ENTRYPOINT_DRAIN_TIMEOUT');})]);assert.equal(child.exitCode,0,child.output);}
 t.after(async()=>{for(const child of children)if(child.exitCode===null&&child.signalCode===null)await stop(child);assert.equal(path.dirname(path.resolve(tmp)),path.resolve(os.tmpdir()));assert.ok(path.basename(tmp).startsWith('listening-process-'));await fs.rm(tmp,{recursive:true,force:true});});
 async function start(value){const configFile=path.join(tmp,'config.json');await fs.writeFile(configFile,JSON.stringify(value));const preload=process.platform==='win32'?['--import','data:text/javascript,'+encodeURIComponent('process.on("message",value=>{if(value==="fixture:stop")process.emit("SIGTERM");});')]:[];const child=spawn(process.execPath,[...preload,entry,configFile],{cwd:backend,stdio:['ignore','pipe','pipe',...(process.platform==='win32'?['ipc']:[])]});children.push(child);child.output='';for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{child.output=(child.output+b).slice(-16000);});const end=Date.now()+10000;while(!child.output.includes('"ready":true')){if(child.exitCode!==null||child.signalCode!==null||Date.now()>end)throw Error('ENTRYPOINT_NOT_READY '+child.output);await wait(25);}return child;}
 async function call(route,{token,cookie,method='GET',body,status=200}={}){const response=await fetch(base+route,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),...(cookie?{Cookie:cookie}:{}),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.equal(response.status,status,JSON.stringify(value));return {value,response};}
 const first=await start(config);
 const metadata=(await call('/config')).value;assert.equal(metadata.code,lesson.code);assert.equal(metadata.capabilities.compactDraftAck,true);assert.equal(metadata.capabilities.stateStream,false);
 const login=async studentRef=>(await call('/student/login',{method:'POST',body:{classId:'1293',studentRef}})).value.token;
 const token=await login(A),other=await login(B);
 const body={answers:Object.fromEntries(ids.map(id=>[id,'approved '+id])),annotations:[],notes:'Durable synthetic note',flags:[]},mutation={baseRevision:0,mutationId:randomUUID(),body};
 const ack=(await call('/draft?ack=compact-v1',{token,method:'PUT',body:mutation})).value;assert.equal(ack.responseFormat,'draft-ack-v1');assert.equal(ack.revision,1);assert.equal(Object.hasOwn(ack,'body'),false);
 const replay=(await call('/draft',{token,method:'PUT',body:mutation})).value;assert.equal(replay.revision,1);assert.deepEqual(replay.body,body);
 const submitted=(await call('/submit',{token,method:'POST',body:{revision:1,requestId:randomUUID()},status:202})).value;
 await wait(1800);assert.equal((await call('/attempts/'+submitted.attemptId,{token})).value.status,'queued','workersEnabled=false must not consume the durable queue');
 await call('/attempts/'+submitted.attemptId,{token:other,status:404});
 const teacher=await call('/teacher/login',{method:'POST',body:{credential:'fixture-teacher-allowed',remember:true}}),cookie=teacher.response.headers.get('set-cookie').split(';')[0];assert.match(cookie,/^listening_homework_teacher=/);
 const teacherView=(await call('/teacher/work/1293/'+A,{cookie})).value;assert.equal(teacherView.readonly,true);assert.deepEqual(teacherView.draft.body,body);
 await call('/submit',{cookie,method:'POST',body:{revision:1,requestId:randomUUID()},status:401});
 await stop(first);
 const second=await start({...config,workersEnabled:true});
 const deadline=Date.now()+12000;let result;
 do{result=(await call('/attempts/'+submitted.attemptId,{token})).value;if(result.status==='done')break;await wait(100);}while(Date.now()<deadline);
 assert.equal(result.status,'done',JSON.stringify(result));assert.deepEqual(result.snapshot,body);assert.equal(result.result.grading.summary.allCorrect,true);
 assert.equal((await call('/attempts',{token})).value.attempts.length,1);assert.deepEqual((await call('/draft',{token})).value.body,body);
 assert.equal((await call('/audio',{token})).value.audio.id,lesson.audioId);
 assert.ok(!second.output.includes('AI_HTTP_')&&!second.output.includes('ECONNREFUSED'),second.output);
 await stop(second);
});
