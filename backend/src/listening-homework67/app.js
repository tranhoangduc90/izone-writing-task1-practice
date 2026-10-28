import express from 'express';
import {rateLimit} from 'express-rate-limit';
import {createReading67WebStore,createReading67WebWorker} from '../reading-listening67/web-store.js';
import {createReading67WebRouter} from '../reading-listening67/web-routes.js';
import {createListeningGrader,listeningSummary} from './grader.js';
export const DOC_CONTRACT={cta:'NHẤN VÀO ĐÂY ĐỂ LUYỆN TẬP LISTENING',status:'TÌNH TRẠNG NỘP BÀI LISTENING',prefix:'Listening Homework (tự động): '};
export const listeningProgressText=p=>p?` Kết quả: đạt ${p.correctCount}/${p.total} mục.`+(p.allCorrect?' Đã sửa đúng toàn bộ bài.':` Còn ${p.remainingCount} mục cần sửa.`):'';
export const listeningCompletionText=({runNo,progress})=>progress?.allCorrect?`Đã đạt toàn bộ mục ở lượt luyện ${runNo}.`:`Đã có góp ý cho lượt luyện ${runNo}.`;
export function publicLesson(lesson){
 const {code,version,title,homeworkLesson,minimumCompletion,audioId,groups,questions}=lesson;
 return {code,version,title,homeworkLesson,minimumCompletion,audioId,groups,questions,items:lesson.items.map(({id,group,question})=>({id,group,question}))};
}
export function createListeningHomeworkApp({db,lesson,provider,model='gemini-3.5-flash',identity,homeworkRuntime,audio,origins,studentsOpen=false,googleClientId='',fixture=false,ssoBridge}){
 const content=publicLesson(lesson),grader=createListeningGrader({lesson,provider,model});
 const store=createReading67WebStore({db,grader,homework:homeworkRuntime?.homework,resultSummary:listeningSummary});
 const worker=createReading67WebWorker({store,grader,onError:e=>console.error(JSON.stringify({event:'listening_homework_worker',code:e.code||'FAILED'}))});
 const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
 app.use((q,r,next)=>{r.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});if(q.headers.origin&&!origins.includes(q.headers.origin))return r.status(403).json({error:'ORIGIN_NOT_ALLOWED'});if(q.headers.origin)r.set({'Access-Control-Allow-Origin':q.headers.origin,'Access-Control-Allow-Credentials':'true','Vary':'Origin'});r.set({'Access-Control-Allow-Headers':'Content-Type, Authorization, X-Izone-Csrf','Access-Control-Allow-Methods':'GET, POST, PUT, OPTIONS'});if(q.method==='OPTIONS')return r.sendStatus(204);next();});
 app.use('/api',rateLimit({windowMs:60000,limit:600,standardHeaders:'draft-8',legacyHeaders:false}));
 const prefix='/api/listening-homework67';
 if(ssoBridge)app.post(prefix+'/teacher/shared-session',express.json({limit:'12kb'}),async(q,r)=>{try{if(q.headers['x-izone-csrf']!=='1')return r.sendStatus(403);const response=await ssoBridge(q);for(const cookie of response.headers.getSetCookie())r.append('Set-Cookie',cookie);r.status(response.status).send(await response.text());}catch{r.status(503).json({error:'SSO_UNAVAILABLE'});}});
 app.get(prefix+'/audio',async(q,r)=>{try{if(q.query.teacher==='1')await identity.authorizeTeacher(q,r,String(q.query.classId));else{if(!studentsOpen)throw Object.assign(Error(),{status:423,code:'CLASS_NOT_OPEN'});const who=await identity.authenticate(q);if(!who)throw Object.assign(Error(),{status:401,code:'WEB_UNAUTHORIZED'});}if(!audio||audio.id!==lesson.audioId)throw Error('AUDIO_NOT_CONFIGURED');r.json({ok:true,audio:{...audio,envelopeVersion:'MP3',cloudflare:{version:1,policy:'public-mp3-v1'}}});}catch(e){r.status(e.status||503).json({error:e.code||'AUDIO_UNAVAILABLE'});}});
 app.use(prefix,createReading67WebRouter({store,content,grader,identity,authenticate:identity.authenticate,homework:homeworkRuntime?.homework,registerCta:homeworkRuntime?.registerCta,adminKey:homeworkRuntime?.adminKey,config:{studentsOpen,flagCount:content.items.length,homeworkEnabled:!!homeworkRuntime,googleClientId,fixture,product:'listeninghomework'}}));
 app.get('/health',async(_q,r)=>{try{await db.query('SELECT 1');r.json({ok:true,product:'listening-homework67',code:content.code,version:content.version,studentsOpen,fixture});}catch{r.sendStatus(503);}});
 return {app,store,grader,worker};
}
