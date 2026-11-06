// Native entrypoints, lesson factories and Docs runtime execute unchanged in VM.
// SQL/Google/HTTP/grading are doubles. Journal bridge/SDK/config/signing are real.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {setImmediate as tick} from 'node:timers/promises';
import {createHash,randomUUID} from 'node:crypto';
import vm from 'node:vm';

const [readingRoot,listeningRoot,libraryRoot]=process.argv.slice(2);
assert.ok(readingRoot&&listeningRoot&&libraryRoot,'Pass Reading native root, Listening native root, shared library root');
const {signRpc}=await import(pathToFileURL(path.resolve(libraryRoot,'src/remote-store.mjs')).href);
const scratch=mkdtempSync(path.join(tmpdir(),'homework-native-startup-')),results=[];
try{
 for(const [index,root] of [readingRoot,listeningRoot].entries()){
  const product=index===0?'reading-homework':'listening-homework';
  const directory=path.resolve(root,'src/reading-listening67');
  const bridge=await import(pathToFileURL(path.join(directory,'web-journal-runtime.js')).href);
  const workerDiagnostic=await import(pathToFileURL(path.join(directory,'web-journal-worker.js')).href);
  const entryFile=path.resolve(root,'scripts',index===0?'serve-reading67-web.mjs':'serve-listening-homework67.mjs');
  for(const mode of ['off','missing-config','enabled']){
   const enabled=mode==='enabled',order=[],handlers={},journalArgs=[],routers=[],workers=[],diagnostics=[],sourceHashes={};
   let ended=false,exitCode,rpcCalls=0,releaseSource;
   const waiting=new Promise(resolve=>releaseSource=resolve),key=Buffer.alloc(32,21);
   const journalFile=path.join(scratch,product+'-'+mode+'.json');
   writeFileSync(journalFile,JSON.stringify({version:1,identityKey:key.toString('base64'),ticketKeys:{fixture:key.toString('base64')},
    currentTicketKeyId:'fixture',rpc:{endpoint:'https://fixture.invalid/rpc/'+product,key:key.toString('base64'),
     producerSpool:{version:1,endpoint:'https://fixture.invalid/producer-spool/'+product}}}));
   const env={EXAM_JOURNAL_ENABLED:mode==='off'?'0':'1',EXAM_JOURNAL_LIBRARY_ROOT:libraryRoot,
    EXAM_JOURNAL_CONFIG_FILE:mode==='missing-config'?journalFile+'.absent':journalFile};
   const origin='https://fixture.invalid',ids=['1124'];
   const hw={enabled:true,homeworkLesson:10,owner:{kind:'http',url:origin,keyFile:'/fixture/key'},
    googleAuth:{kind:'oauth-file',path:'/fixture/oauth'},adminKeyFile:'/fixture/admin',pageBase:origin+'/'};
   const base={code:'67-reading-fixture',version:'fixture-v1',targets:[{id:'q1'},{id:'q2'}]};
   const tfng={...base,code:'67-reading-other',type:'tfng'};
   const headings={...base,code:'67-reading-the-desolenator',type:'matching_headings',targets:Array.from({length:15},(_,i)=>({id:'q'+i}))};
   const listening=n=>({code:'67-listening-fixture-'+n,version:'fixture-v1',audioId:'audio-'+n,items:[{id:'U1'},{id:'U2'}]});
   const config={mode:index===0?'https_classroom':'production',port:18888,dataDir:'/fixture/data',pagesPath:'/fixture/pages',
    authority:{kind:'http',url:origin,keyFile:'/fixture/key'},database:{kind:'postgres',connectionFile:'/fixture/connection'},
    contentPath:'/fixture/base',graderPath:'/fixture/grader',graderSha256:'a'.repeat(64),allowedClassIds:ids,
    homework:hw,origins:[origin],workCoordinatorEnabled:true,workersEnabled:true,studentsOpen:true,
    owner:{url:origin,keyFile:'/fixture/key'},lessonPath:'/fixture/listening-1',audioPath:'/fixture/audio-1',
    allowAllCourse67:true,sso:{bridgeUrl:origin+'/sso'},ai:{endpoint:origin+'/ai'},
    additionalLessons:index===0?[
     {kind:'tfng',route:'/other',contentPath:'/fixture/tfng',graderPath:'/fixture/grader',studentsOpen:true,allowedClassIds:ids,homework:hw},
     {kind:'matching_headings',route:'/headings',contentPath:'/fixture/headings',graderPath:'/fixture/grader',studentsOpen:true,allowedClassIds:ids,homework:hw},
    ]:[2,3].map(n=>({lessonPath:'/fixture/listening-'+n,audioPath:'/fixture/audio-'+n,allowedClassIds:ids,homework:hw}))};
   const jsonFiles={'/fixture/config':config,'/fixture/base':base,'/fixture/tfng':tfng,'/fixture/headings':headings,
    '/fixture/oauth':{client_id:'fixture',client_secret:'fixture',refresh_token:'fixture'}};
   for(const n of [1,2,3]){jsonFiles['/fixture/listening-'+n]=listening(n);jsonFiles['/fixture/audio-'+n]={id:'audio-'+n};}
   const fs={async readFile(name){const key=String(name);if(key==='/fixture/admin')return'a'.repeat(40);
    if(['/fixture/key','/fixture/connection'].includes(key))return'fixture';assert.ok(jsonFiles[key],'Unexpected file: '+key);return JSON.stringify(jsonFiles[key]);},async mkdir(){}};
   const observation={async close(){order.push('observations.close');}};
   const db={webObservations:observation,workCoordinator:{register(){order.push('docs.start');return{async close(){order.push('docs.stop');}};}},
    async query(){return{rows:[index===0?{db:'reading67_materials_ic2304',role:'reading67_materials_app',rolsuper:false}:
     {db:'listening_homework67',role:'listening_homework67_app',rolsuper:false,rolcreatedb:false,rolcreaterole:false}]};},
    async close(){ended=true;order.push('db.close');}};
   const state={classes:async()=>ids.map(id=>({id})),snapshot:async()=>({classes:ids.map(id=>({erp_course_class_id:id}))})};
   const grader=content=>({config:{code:content.code,version:content.version},profile:{expected_target_ids:content.targets.map(t=>t.id)}});
   const express=()=>({use(){},disable(){},set(){},get(){},listen(_port,_host,ready){order.push('http.listen');ready();return{
    close(done){order.push('http.close');done();}};}});
   express.static=()=>()=>{};
   class OAuth2Client{setCredentials(){}}
   const mock={
    'node:fs/promises':{default:fs,readFile:fs.readFile},'node:path':{default:path},
    'node:child_process':{execFile(){}},'node:util':{promisify:()=>async()=>({})},
    express:{default:express},'express-rate-limit':{rateLimit:()=>()=>{}},'google-auth-library':{OAuth2Client},
    'context.js':{createContext:()=>state,createListeningContext:()=>state},
    'context-contract.js':{createContextSnapshot:value=>value,parseContextSnapshot:value=>value},
    'web-identity.js':{createReading67WebIdentity:()=>({authenticate(){}})},
    'web-owner-source.js':{createReading67OwnerSource:()=>({})},'web-course67-scope.js':{createCourse67Scope:()=>({})},
    'web-postgres.js':{createReading67Postgres:()=>db},
    'web-grader.js':{loadReading67WebGrader:async()=>grader(base),sha256:()=> 'a'.repeat(64),WebGradingError:Error},
    'web-tfng-grader.js':{loadReading67TfngGrader:async()=>grader(tfng)},
    'web-headings-grader.js':{loadReading67HeadingsGrader:async()=>grader(headings)},
    'web-green-roofs-grader.js':{loadGreenRoofsGrader:async()=>{}},
    'web-sentence-grader.js':{loadReading67SentenceGrader:async()=>{}},'web-people-grader.js':{loadReading67PeopleGrader:async()=>{}},
    'web-store.js':{createReading67WebStore:()=>({recoverExpired:async()=>{}}),
     createReading67WebWorker:options=>{workers.push(options);return{start(){order.push('worker.start');},async close(){order.push('worker.close');}};}},
    'web-routes.js':{createReading67WebRouter:options=>{routers.push(options);return{};}},
    'web-homework-docs.js':{createReading67GoogleDocs:()=>({}),locateReading67Homework(){},planReading67HomeworkWrite(){}},
    'web-homework-owner.js':{createReading67HomeworkOwner:()=>({})},'web-homework-cta.js':{createReading67CtaRegistrar:()=>()=>{},createReading67CtaDispatcher:()=>()=>{}},
    'web-owner-entry.js':{createReading67OwnerEntry:()=>({})},'cta-confirmation-client.js':{publisherFromEnv:()=>()=>{},verifyClassroomCopy:()=>()=>{}},
    'web-homework.js':{createReading67Homework:options=>{journalArgs.push(options);return{once:async()=>{}};}},
    'web-share-practice.js':{createReadingSharePractice:()=>({}),createReadingShareWorker:()=>({start(){},async close(){order.push('share.close');}})},
    'web-journal-worker.js':workerDiagnostic,'web-journal-runtime.js':bridge,
    'grader.js':{listeningSummary(){}},
    'app.js':{DOC_CONTRACT:{},listeningProgressText(){},listeningCompletionText(){},createListeningHomeworkApp:options=>{
     routers.push(options);return{app:express(),worker:{start(){order.push('worker.start');},async close(){order.push('worker.close');}}};}},
    'lesson-router.js':{createListeningLessonRouter:runtimes=>{assert.equal(runtimes.length,3);return express();}},
   };
   const actual=new Set(['web-additional-lessons.js','web-headings-lesson.js','web-homework-runtime.js']);
   const context=vm.createContext({process:{argv:['node',entryFile,'/fixture/config'],env,on:(name,fn)=>handlers[name]=fn,
    exit:code=>{exitCode=code;order.push('process.exit');}},console:{log(){},error:value=>diagnostics.push(value)},
    fetch:async()=>new Response(JSON.stringify({context:{classes:ids.map(id=>({erp_course_class_id:id}))}})),
    Response,AbortSignal,URL,crypto:{randomUUID},setTimeout,clearTimeout});
   const cache=new Map();
   async function load(file){
    if(cache.has(file))return cache.get(file);
    const source=readFileSync(file,'utf8');sourceHashes[file]=createHash('sha256').update(source).digest('hex');
    const module=new vm.SourceTextModule(source,{context,identifier:file});cache.set(file,module);
    await module.link(async(specifier,parent)=>{
     const name=path.basename(specifier);
     if(actual.has(name))return load(path.resolve(path.dirname(parent.identifier),specifier));
     const exports=mock[specifier]||mock[name];assert.ok(exports,'Unexpected dependency: '+specifier);
     const key='mock:'+specifier;if(cache.has(key))return cache.get(key);
     const names=Object.keys(exports),child=new vm.SyntheticModule(names,function(){for(const n of names)this.setExport(n,exports[n]);},{context});
     cache.set(key,child);return child;
    });return module;
   }
   const originalFetch=globalThis.fetch,originalError=console.error;
   globalThis.fetch=async(url,options)=>{
    assert.ok(String(url).startsWith('https://fixture.invalid/'));rpcCalls++;
    const {envelope}=JSON.parse(options.body);assert.equal(envelope.productId,product);assert.equal(envelope.method,'ping');
    const receipt={version:1,productId:product,nonce:envelope.nonce,method:'ping',result:{ok:true,available:true}};
    return new Response(JSON.stringify({receipt,signature:signRpc(key,receipt)}));
   };
   console.error=value=>diagnostics.push(value);
   try{
    const entry=await load(entryFile);await entry.evaluate();await tick();
    assert.equal(journalArgs.length,3,'All three native lessons create a Docs runtime');assert.equal(routers.length,3);
    if(index===0)assert.equal(workers.length,3,'Base, additional and Headings all have worker hooks');
    const journal=journalArgs[0].journal;
    if(enabled){
     assert.ok(journal&&typeof journal.scheduleSource==='function');
     assert.ok(journalArgs.every(value=>value.journal===journal));assert.ok(routers.every(value=>value.journal===journal));
     if(index===0)assert.ok(workers.every(value=>typeof value.onStart==='function'));
     assert.equal(journal.scheduleSource(async()=>{order.push('source.started');await waiting;assert.equal(ended,false);order.push('source.done');return{ok:true};}),true);
    }else{
     assert.ok(journalArgs.every(value=>!value.journal));assert.ok(routers.every(value=>!value.journal));
     if(index===0)assert.ok(workers.every(value=>value.onStart===null));
    }
    const closing=handlers.SIGTERM();await tick();
    if(enabled){assert.equal(ended,false);assert.ok(order.includes('observations.close'));releaseSource();}
    await closing;await handlers.SIGINT();assert.equal(exitCode,0);assert.equal(order.filter(x=>x==='db.close').length,1);
    assert.ok(order.indexOf('http.close')<order.indexOf('db.close'));
    if(enabled)assert.ok(order.indexOf('source.done')<order.indexOf('db.close'));
    assert.equal(rpcCalls,enabled?1:0);
    if(mode==='missing-config')assert.ok(diagnostics.some(value=>String(value).includes('START_FAILED')));
    results.push({product,mode,status:'passed',lessons:3,rpcCalls,order,sourceHashes});
   }finally{releaseSource();globalThis.fetch=originalFetch;console.error=originalError;}
  }
 }
 console.log(JSON.stringify({status:'passed',cases:results.length,limits:'Native script/lesson factories/Docs runtime and journal bridge/SDK execute; SQL/Google/HTTP/grader/RPC isolated doubles',results},null,2));
}finally{rmSync(scratch,{recursive:true,force:true});}
