/** Adapter bài Headings trong runtime Reading Homework hiện hành. */
import {readFile} from 'node:fs/promises';
import {loadReading67HeadingsGrader} from './web-headings-grader.js';
import {createReadingSharePractice} from './web-share-practice.js';
import {createReading67WebIdentity} from './web-identity.js';
import {createReading67OwnerSource} from './web-owner-source.js';
import {createReading67HomeworkRuntime} from './web-homework-runtime.js';
import {createReading67WebStore,createReading67WebWorker} from './web-store.js';
import {createReading67WebRouter} from './web-routes.js';
export async function createReading67HeadingsLesson({config,db,context,initial,verifyGoogle,cookiePath,googleClientId,demo=false,managedCodes=[]}){
 const content=JSON.parse(await readFile(config.contentPath,'utf8'));
 const grader=await loadReading67HeadingsGrader({snapshotPath:config.graderPath,expectedSha256:config.graderSha256});
 if(content.type!=='matching_headings'||content.code!=='67-reading-the-desolenator'||content.targets.length!==15||new Set(content.targets.map(t=>t.id)).size!==15||content.targets.some(t=>!grader.profile.expected_target_ids.includes(t.id)))throw Error('LESSON_DEFINITION_MISMATCH');
 if(!Array.isArray(config.allowedClassIds)||!config.allowedClassIds.length||config.allowedClassIds.some(id=>!initial.classes.some(c=>c.erp_course_class_id===String(id))))throw Error('LESSON_CLASSES_INVALID');
 const ownerSource=config.homework?.owner?.kind==='http'?createReading67OwnerSource({context,allowedClassIds:config.allowedClassIds,url:config.homework.owner.url,key:(await readFile(config.homework.owner.keyFile,'utf8')).trim()}):null;
 const identity=createReading67WebIdentity({db,context,allowedClassIds:config.allowedClassIds,verifyGoogle,ownerSource,cookiePath,includeEmptyClasses:true});
 const homeworkRuntime=config.homework?.enabled?await createReading67HomeworkRuntime({config:config.homework,db,content,identity,ownerSource,managedCodes}):null;
 const practice=createReadingSharePractice({db,content,onProgress:(tx,scope,id,outcome)=>homeworkRuntime?.homework.practiceChanged(tx,scope,id,outcome)});
 const store=createReading67WebStore({db,grader,homework:homeworkRuntime?.homework,jobScope:{code:content.code,version:content.version},beforeSubmit:practice.requireAccepted,afterSubmit:practice.attachAttempt});
 await store.recoverExpired();
 const worker=createReading67WebWorker({store,grader,onError:error=>console.error(JSON.stringify({event:'reading_headings_error',code:error.code||'FAILED'}))});
 const router=createReading67WebRouter({store,content,grader,identity,authenticate:identity.authenticate,homework:homeworkRuntime?.homework,registerCta:homeworkRuntime?.registerCta,adminKey:homeworkRuntime?.adminKey,practice,config:{studentsOpen:config.studentsOpen,type:content.type,lesson:content.lesson,flagCount:5,homeworkEnabled:!!homeworkRuntime,homeworkMode:homeworkRuntime?.mode,demo,demoGoogle:demo,googleClientId,authority:demo?'fixture':'Reading context V1'}});
 let closed=false,pending=null,timer;async function tick(){if(closed)return;pending=practice.once();try{await pending;}catch(error){console.error(JSON.stringify({event:'reading_share_error',code:error.code||'FAILED'}));}finally{pending=null;if(!closed)timer=setTimeout(tick,1000);}}
 return {route:config.route,code:content.code,version:content.version,store,router,cta:homeworkRuntime?{code:content.code,registerCta:homeworkRuntime.registerCta,adminKey:homeworkRuntime.adminKey}:null,start(){worker.start();homeworkRuntime?.start();tick();},async close(){closed=true;clearTimeout(timer);await pending;await worker.close();await homeworkRuntime?.close();}};
}
