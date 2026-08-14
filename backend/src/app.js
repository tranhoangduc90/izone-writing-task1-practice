import crypto from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { ApiError } from './service.js';

const uuid=z.string().uuid(), section=z.enum(['overview','outline','draft']);
const meaningfulText = (value) => value.replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu, '');
const draft=z.object({overview:z.string().max(20_000),body1:z.string().max(20_000),body2:z.string().max(20_000),draft1:z.string().max(20_000).optional(),draft2:z.string().max(20_000).optional(),draft2Unlocked:z.boolean().optional()});
const open=z.object({activitySlug:z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/),classRef:uuid,studentRef:uuid});
const save=z.object({baseVersion:z.number().int().min(0),requestId:uuid,...draft.shape});
const check=z.object({section,requestId:uuid,snapshot:draft}).superRefine((value,context)=>{
 if(value.section==='overview'&&!meaningfulText(value.snapshot.overview))context.addIssue({code:'custom',path:['snapshot','overview'],message:'Overview trống.'});
 if(value.section==='outline'&&!meaningfulText(value.snapshot.body1)&&!meaningfulText(value.snapshot.body2))context.addIssue({code:'custom',path:['snapshot'],message:'Outline trống.'});
 if(value.section==='draft'&&(!meaningfulText(value.snapshot.draft1||'')||!meaningfulText(value.snapshot.draft2||'')))context.addIssue({code:'custom',path:['snapshot'],message:'Draft 1 và Draft 2 không được để trống.'});
});
const claim=z.object({workerId:z.string().trim().min(1).max(100),maxJobs:z.number().int().min(1).max(4).default(1),leaseSeconds:z.literal(420)});
const gradingResult=z.enum(['passed','needs_revision']);
const complete=z.object({leaseToken:uuid,resultStatus:gradingResult.optional(),status:gradingResult.optional(),feedback:z.string().trim().min(1).max(20_000)})
 .superRefine((value,context)=>{if(!value.resultStatus&&!value.status)context.addIssue({code:'custom',path:['status'],message:'Thiếu kết quả chấm.'});})
 .transform(value=>({...value,resultStatus:value.resultStatus||value.status}));
const fail=z.object({leaseToken:uuid,errorCode:z.string().trim().min(1).max(100),retryable:z.boolean()});
const reopen=z.object({reason:z.string().trim().min(3).max(500)});
const parse=(schema,value,code='INVALID_REQUEST')=>{const r=schema.safeParse(value);if(!r.success)throw new ApiError(400,code,'Dữ liệu gửi lên không hợp lệ.');return r.data;};
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
function sameSecret(actual,expected){const a=Buffer.from(String(actual||'')),b=Buffer.from(String(expected||''));return a.length>0&&a.length===b.length&&crypto.timingSafeEqual(a,b);}
function cors(config){return(req,res,next)=>{const origin=req.get('origin');if(origin&&!config.allowedOrigins.has(origin))return res.status(403).json({ok:false,error:'ORIGIN_NOT_ALLOWED'});if(origin){res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');}res.set('Access-Control-Allow-Methods','GET, POST, PUT, OPTIONS');res.set('Access-Control-Allow-Headers','Authorization, Content-Type, If-None-Match, If-Match');res.set('Cache-Control','no-store');return req.method==='OPTIONS'?res.status(204).end():next();};}

export function createApp({config,pool,service,adminAuth=(_q,r)=>r.status(503).json({ok:false,error:'ADMIN_AUTH_NOT_CONFIGURED'})}){
 const app=express();app.disable('x-powered-by');app.set('trust proxy',config.trustProxyHops);app.use(helmet());app.use(cors(config));
 // Một lớp có thể dùng chung một địa chỉ mạng. Ngưỡng đọc này vẫn chịu được 40 học viên polling 2 giây/lần.
 app.use(rateLimit({windowMs:60_000,limit:2400,standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,error:'RATE_LIMITED'}}));app.use(express.json({limit:'96kb',strict:true}));
 app.get('/health',(_q,r)=>r.json({ok:true}));app.get('/ready',asyncRoute(async(_q,r)=>{await pool.query('SELECT 1');r.json({ok:true});}));const writes=rateLimit({windowMs:60_000,limit:240,standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,error:'RATE_LIMITED'}});
 app.get('/api/v1/activities/:slug/roster',asyncRoute(async(q,r)=>r.json({ok:true,...await service.getRoster(q.params.slug)})));
 app.post('/api/v1/sessions',writes,asyncRoute(async(q,r)=>r.status(201).json({ok:true,session:await service.openSession(parse(open,q.body))})));
 app.get('/api/v1/sessions/:sessionRef',asyncRoute(async(q,r)=>r.json({ok:true,session:await service.sessionDetails(parse(uuid,q.params.sessionRef))})));
 app.put('/api/v1/sessions/:sessionRef/draft',writes,asyncRoute(async(q,r)=>r.json({ok:true,session:await service.saveDraft({sessionRef:parse(uuid,q.params.sessionRef),...parse(save,q.body)})})));
 app.post('/api/v1/sessions/:sessionRef/checks',writes,asyncRoute(async(q,r)=>r.status(202).json({ok:true,attempt:await service.submitCheck({sessionRef:parse(uuid,q.params.sessionRef),...parse(check,q.body)})})));
 app.get('/api/v1/attempts/:attemptRef',asyncRoute(async(q,r)=>{const attempt=await service.getAttempt(parse(uuid,q.params.attemptRef));const tag=`"attempt-${attempt.version}"`;if(q.get('if-none-match')===tag)return r.status(304).end();r.set('ETag',tag);return r.json({ok:true,attempt});}));
 app.post('/api/v1/attempts/:attemptRef/retry',writes,asyncRoute(async(q,r)=>r.status(202).json({ok:true,attempt:await service.retryAttempt(parse(uuid,q.params.attemptRef))})));
 const internal=(q,r,next)=>sameSecret((q.get('authorization')||'').replace(/^Bearer\s+/i,''),config.internalApiToken)?next():r.status(401).json({ok:false,error:'UNAUTHORIZED'});
 app.post('/api/v1/internal/grading-jobs/claim',internal,asyncRoute(async(q,r)=>r.json({ok:true,jobs:await service.claimJobs(parse(claim,q.body))})));
 app.post('/api/v1/internal/grading-jobs/:jobRef/complete',internal,asyncRoute(async(q,r)=>r.json({ok:true,job:await service.completeJob({jobRef:parse(uuid,q.params.jobRef),...parse(complete,q.body)})})));
 app.post('/api/v1/internal/grading-jobs/:jobRef/fail',internal,asyncRoute(async(q,r)=>r.json({ok:true,job:await service.failJob({jobRef:parse(uuid,q.params.jobRef),...parse(fail,q.body)})})));
 app.post('/api/v1/internal/grading-jobs/recover',internal,asyncRoute(async(_q,r)=>r.json({ok:true,jobs:await service.recoverJobs()})));
 app.post('/api/v1/admin/sessions/:sessionRef/sections/:section/reopen',adminAuth,asyncRoute(async(q,r)=>r.json({ok:true,session:await service.reopenSection({sessionRef:parse(uuid,q.params.sessionRef),section:parse(section,q.params.section),actorRef:q.reviewer.email,...parse(reopen,q.body)})})));
 app.use((_q,r)=>r.status(404).json({ok:false,error:'NOT_FOUND'}));app.use((error,_q,r,_n)=>{if(error instanceof ApiError)return r.status(error.status).json({ok:false,error:error.code,message:error.message,...(error.current?{current:error.current}:{})});const requestId=crypto.randomUUID();console.error(`Writing Task 1 API error request_id=${requestId} type=${error?.name||'Error'}`);return r.status(500).json({ok:false,error:'INTERNAL_ERROR',requestId});});return app;
}
