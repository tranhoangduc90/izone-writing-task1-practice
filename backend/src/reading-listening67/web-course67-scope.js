// Read-only class metadata. Student/teacher authorization remains in live context.
import {z} from 'zod';
import {sha256,WebGradingError} from './web-grader.js';
const row=z.object({classId:z.string().regex(/^[1-9]\d*$/),classCode:z.string().trim().min(1).max(100),courseId:z.string().min(1).max(100)}).strict();
const schema=z.object({apiVersion:z.literal(1),erpCourseId:z.literal('5'),classes:z.array(row).max(1000),capturedAt:z.iso.datetime(),sourceRevision:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
export function createCourse67Scope({url,key,fetcher=fetch,clock=Date.now}){
 let cached,pending;
 const fail=()=>{throw new WebGradingError('COURSE67_SCOPE_UNAVAILABLE',503);};
 async function load(){
  const response=await fetcher(url.replace(/\/$/,'')+'/v1/homework/class-scope',{headers:{'x-k67-context-key':key},signal:AbortSignal.timeout(5000)});
  if(!response.ok)fail();const text=await response.text();if(Buffer.byteLength(text)>262144)fail();
  const parsed=schema.safeParse(JSON.parse(text));if(!parsed.success)fail();
  const {capturedAt,sourceRevision,...payload}=parsed.data,age=clock()-Date.parse(capturedAt);
  if(age< -5000||age>120000||sha256(JSON.stringify(payload))!==sourceRevision||new Set(payload.classes.map(c=>c.classId)).size!==payload.classes.length||new Set(payload.classes.map(c=>c.classCode.toUpperCase())).size!==payload.classes.length||new Set(payload.classes.map(c=>c.courseId)).size!==payload.classes.length)fail();
  cached={at:clock(),capturedAt,classes:payload.classes};return cached.classes;
 }
 async function classes(){
  if(cached&&clock()-cached.at<30000&&clock()-Date.parse(cached.capturedAt)<120000)return cached.classes;
  if(pending)return pending;
  pending=load();try{return await pending;}catch{fail();}finally{pending=undefined;}
 }
 async function allowed(ids){return new Set([...ids.map(String),...(await classes()).map(c=>c.classId)]);}
 return {classes,allowed};
}
