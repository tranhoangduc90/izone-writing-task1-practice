/**
 * Khởi tạo hàng Docs riêng từ cấu hình private. Bản thử chỉ chấp nhận danh sách
 * hồ sơ giả được ghim; đường Classroom thật dùng owner V1 và không tự bật.
 * Token lấy trong bộ nhớ, không ghi log. Lỗi Google không chặn lưu bài trên SQL.
 */
import fs from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {OAuth2Client} from 'google-auth-library';
import {WebGradingError} from './web-grader.js';
import {createReading67GoogleDocs,locateReading67Homework,planReading67HomeworkWrite} from './web-homework-docs.js';
import {createReading67HomeworkOwner} from './web-homework-owner.js';
import {createReading67Homework} from './web-homework.js';
import {createReading67CtaRegistrar} from './web-homework-cta.js';
const run=promisify(execFile);
const fail=code=>{throw new WebGradingError(code,403);};
export async function createReading67HomeworkRuntime({config,db,content,identity,ownerSource,contract,resultSummary,progressText,completionText,managedCodes=[]}){
 const locate=(d,b)=>locateReading67Homework(d,b,contract),planWrite=(d,b,j)=>planReading67HomeworkWrite(d,b,j,contract);
 const metadata={code:content.code,version:content.version,homeworkLesson:config.homeworkLesson,...(content.practice?{practiceRequired:true}:{})};
 let auth;
 if(config.googleAuth.kind==='command'){
  let cached,until=0;
  auth={async getAccessToken(){if(Date.now()<until)return cached;const result=await run(config.googleAuth.command,config.googleAuth.args,{timeout:25000,maxBuffer:65536,windowsHide:true});cached=JSON.parse(result.stdout).token;if(typeof cached!=='string'||cached.length<20)throw Error('DOC_AUTH_UNAVAILABLE');until=Date.now()+45*60000;return cached;}};
 }else if(config.googleAuth.kind==='oauth-file'){
  const value=JSON.parse(await fs.readFile(config.googleAuth.path,'utf8'));
  auth=new OAuth2Client(value.client_id,value.client_secret);auth.setCredentials({refresh_token:value.refresh_token});
 }else throw Error('DOC_AUTH_CONFIG_REQUIRED');
 const docs=createReading67GoogleDocs(auth);
 let owner;
 if(config.owner.kind==='explicit_test_fixture'){
  const fixture=JSON.parse(await fs.readFile(config.owner.path,'utf8'));
  if(fixture.mode!=='explicit_test_fixture'||fixture.code!==content.code||fixture.version!==content.version||fixture.homeworkLesson!==config.homeworkLesson)throw Error('DOC_FIXTURE_INVALID');
  const targets=fixture.targets;
  if(!Array.isArray(targets)||!targets.length||new Set(targets.map(t=>t.documentId)).size!==targets.length)throw Error('DOC_FIXTURE_INVALID');
  async function verify(target){
   const expected=targets.find(t=>t.classId===target.classId&&t.studentRef===target.studentRef);
   if(!expected||Object.keys(expected).filter(k=>k!=='googleUserId').some(k=>target[k]!==expected[k])||(target.googleUserId&&target.googleUserId!==expected.googleUserId))fail('DOC_IDENTITY_MISMATCH');
   const doc=await docs.read(expected.documentId);locate(doc,{document_id:expected.documentId,tab_id:expected.tabId,code:content.code});
   return {...expected,sourceMode:'explicit_test_fixture'};
  }
  owner={verify,async resolve(scope,cached){
   const target=targets.find(t=>t.classId===scope.courseId&&t.studentRef===scope.ownerId&&t.code===scope.code&&t.version===scope.version);
   if(!target)throw new WebGradingError('HOMEWORK_NOT_FOUND',409);
   return verify(cached||target);
  },async resolveClassroom(input){
   const matching=targets.filter(t=>t.courseId===input.courseId&&t.googleUserId===input.googleUserId);
   if(matching.length!==1)fail('OWNER_MISMATCH');return matching[0];
  }};
 }else if(config.owner.kind==='http')owner=createReading67HomeworkOwner({url:config.owner.url,key:(await fs.readFile(config.owner.keyFile,'utf8')).trim(),auth,docs,metadata,ownerSource,locate});
 else throw Error('DOC_OWNER_CONFIG_REQUIRED');
 const homework=createReading67Homework({db,metadata,pageBase:config.pageBase,owner,docs,planWrite,resultSummary,progressText,completionText,managedCodes});
 const adminKey=(await fs.readFile(config.adminKeyFile,'utf8')).trim();if(adminKey.length<32)throw Error('CTA_ADMIN_KEY_REQUIRED');
 let stopped=false,running=null,timer;
 async function tick(){if(stopped)return;running=homework.once();try{await running;}catch(error){console.error(JSON.stringify({event:'reading67_homework_error',code:error.code||'DOC_RETRY'}));}finally{running=null;if(!stopped)timer=setTimeout(tick,500);}}
 return {homework,docs,owner,adminKey,registerCta:createReading67CtaRegistrar({homework,owner,docs,identity,metadata,locate,planWrite}),start(){tick();},async close(){stopped=true;clearTimeout(timer);await running;},mode:config.owner.kind};
}
