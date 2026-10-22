/**
 * Nhận identity từ middleware máy chủ, không nhận owner từ JSON học viên.
 * Trả nháp/kết quả đúng phạm vi; lỗi CAS, thiếu bài và lỗi chấm có mã riêng.
 * Bộ route không tự mở đăng nhập giả; fixture chỉ có ở entrypoint thử localhost.
 */
import express from 'express';
import {z} from 'zod';
import {WebGradingError} from './web-grader.js';
const saveInput=z.object({baseRevision:z.number().int().nonnegative(),mutationId:z.uuid(),body:z.object({answers:z.record(z.string(),z.string().max(12000)),annotations:z.array(z.record(z.string(),z.unknown())).max(300),notes:z.string().max(16000),flags:z.array(z.number().int().min(1).max(4)).max(4)}).strict()}).strict();
const submitInput=z.object({revision:z.number().int().positive(),requestId:z.uuid()}).strict();
const id=z.uuid();
export function createReading67WebRouter({store,content,grader,authenticate}){
  const router=express.Router();router.use(express.json({limit:'250kb',strict:true}));
  router.use(async(q,r,next)=>{try{q.webIdentity=await authenticate(q);if(!q.webIdentity)throw new WebGradingError('WEB_UNAUTHORIZED',401);next();}catch(error){next(error);}});
  const scope=q=>({ownerId:q.webIdentity.ownerId,courseId:q.webIdentity.courseId,code:content.code,version:content.version});
  const route=fn=>(q,r,next)=>Promise.resolve(fn(q,r)).catch(next);
  const parse=(schema,value)=>{const result=schema.safeParse(value);if(!result.success)throw new WebGradingError('WEB_INVALID_INPUT',400);return result.data;};
  router.get('/lesson',route(async(q,r)=>r.json({ok:true,content,identity:q.webIdentity,grader:{hash:grader.pins.sha256,version:grader.pins.workflowVersion},mode:'local_test_real_grading'})));
  router.get('/draft',route(async(q,r)=>r.json({ok:true,...await store.draft(scope(q))})));
  router.put('/draft',route(async(q,r)=>r.json({ok:true,...await store.save(scope(q),parse(saveInput,q.body))})));
  router.post('/submit',route(async(q,r)=>r.status(202).json({ok:true,...await store.submit(scope(q),parse(submitInput,q.body))})));
  router.get('/attempts',route(async(q,r)=>r.json({ok:true,attempts:await store.history(scope(q))})));
  router.get('/attempts/:id',route(async(q,r)=>r.json({ok:true,...await store.attempt(scope(q),parse(id,q.params.id))})));
  router.use((error,_q,r,_next)=>{
    const known=error instanceof WebGradingError;
    r.status(known?error.status:error.type==='entity.parse.failed'?400:error.type==='entity.too.large'?413:503).json({ok:false,error:known?error.code:'WEB_UNAVAILABLE',...(known?{details:error.details}:{})});
  });return router;
}
