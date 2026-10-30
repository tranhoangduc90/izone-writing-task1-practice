/** Thêm bài vào cùng sản phẩm Homework; mỗi hàng chấm/Docs được giới hạn theo mã và phiên bản. */
import {readFile} from 'node:fs/promises';
import {createReading67HeadingsLesson} from './web-headings-lesson.js';
import {loadReading67TfngGrader} from './web-tfng-grader.js';
import {loadGreenRoofsGrader} from './web-green-roofs-grader.js';
import {loadReading67SentenceGrader} from './web-sentence-grader.js';
import {loadReading67PeopleGrader} from './web-people-grader.js';
import {createReading67WebIdentity} from './web-identity.js';
import {createReading67OwnerSource} from './web-owner-source.js';
import {createReading67HomeworkRuntime} from './web-homework-runtime.js';
import {createReading67WebStore,createReading67WebWorker} from './web-store.js';
import {createReading67WebRouter} from './web-routes.js';
export async function createAdditionalReading67Lessons({configs=[],db,context,initial,verifyGoogle,cookiePath,googleClientId,demo=false,managedCodes=[]}){
 if(!Array.isArray(configs)||configs.length>20||new Set(configs.map(c=>c.route)).size!==configs.length)throw Error('ADDITIONAL_LESSONS_INVALID');
 const runtimes=[];
 for(const config of configs){
  if(!/^\/[a-z0-9-]+$/.test(config.route)||typeof config.studentsOpen!=='boolean'||demo&&config.homework?.enabled)throw Error('ADDITIONAL_LESSON_CONFIG_INVALID');
  if(config.kind==='matching_headings'){runtimes.push(await createReading67HeadingsLesson({config,db,context,initial,verifyGoogle,cookiePath,googleClientId,demo,managedCodes}));continue;}
  const content=JSON.parse(await readFile(config.contentPath,'utf8'));
  const loader=content.type==='matching_people'?loadReading67PeopleGrader:loadGreenRoofsGrader;
  const grader=content.type==='sentence_completion'?await loadReading67SentenceGrader({snapshotPath:config.graderPath,expectedSha256:config.graderSha256}):['green-roofs','matching_people'].includes(content.type)?await loader({snapshotPath:config.graderPath,expectedSha256:config.graderSha256,auditPath:config.auditPath,auditSha256:config.auditSha256}):await loadReading67TfngGrader({snapshotPath:config.graderPath,expectedSha256:config.graderSha256});
  if(!['tfng','green-roofs','matching_people','sentence_completion'].includes(content.type)||content.code!==grader.config.code||content.version!==grader.config.version||content.targets.length!==grader.profile.expected_target_ids.length||new Set(content.targets.map(t=>t.id)).size!==content.targets.length||content.targets.some(t=>!grader.profile.expected_target_ids.includes(t.id)))throw Error('LESSON_DEFINITION_MISMATCH');
  const allowedClassIds=config.allowedClassIds;
  if(!Array.isArray(allowedClassIds)||!allowedClassIds.length||allowedClassIds.some(id=>!initial.classes.some(c=>c.erp_course_class_id===String(id))))throw Error('LESSON_CLASSES_INVALID');
  const ownerSource=config.homework?.owner?.kind==='http'?createReading67OwnerSource({context,allowedClassIds,url:config.homework.owner.url,key:(await readFile(config.homework.owner.keyFile,'utf8')).trim()}):null;
  const identity=createReading67WebIdentity({db,context,allowedClassIds,verifyGoogle,ownerSource,cookiePath,includeEmptyClasses:true});
  const homeworkRuntime=config.homework?.enabled?await createReading67HomeworkRuntime({config:config.homework,db,content,identity,ownerSource,managedCodes}):null;
  const store=createReading67WebStore({db,grader,homework:homeworkRuntime?.homework,jobScope:{code:content.code,version:content.version}});
  await store.recoverExpired();
  const worker=createReading67WebWorker({store,grader,onError:error=>console.error(JSON.stringify({event:'reading_homework_grading_error',lesson:content.lesson,code:error.code||'FAILED'}))});
  const router=createReading67WebRouter({store,content,grader,identity,authenticate:identity.authenticate,homework:homeworkRuntime?.homework,registerCta:homeworkRuntime?.registerCta,adminKey:homeworkRuntime?.adminKey,config:{studentsOpen:config.studentsOpen,homeworkEnabled:!!homeworkRuntime,homeworkMode:homeworkRuntime?.mode,demo,demoGoogle:demo,googleClientId,authority:demo?'fixture':'Reading context V1'}});
  runtimes.push({route:config.route,code:content.code,version:content.version,store,router,cta:homeworkRuntime?{code:content.code,registerCta:homeworkRuntime.registerCta,adminKey:homeworkRuntime.adminKey}:null,async start(){worker.start();homeworkRuntime?.start();},async close(){await worker.close();await homeworkRuntime?.close();}});
 }
 return runtimes;
}
