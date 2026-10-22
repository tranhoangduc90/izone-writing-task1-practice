// HTTP thật kiểm origin, Google audience và khóa consumer; không nhận danh tính tự khai.
import express from 'express';
import {rateLimit} from 'express-rate-limit';
import {timingSafeEqual} from 'node:crypto';
export function createTeacherSsoApp({config,sources,service,consumerKeys,verifyGoogleToken}){
const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
// Endpoint này chỉ đi trên mạng nội bộ; Nginx công khai phải chặn /internal/.
app.post('/internal/identity/:product',(q,r)=>{
 const expected=consumerKeys.get(q.params.product),supplied=q.headers['x-izone-sso-consumer'];
 if(!expected||typeof supplied!=='string'||Buffer.byteLength(expected)!==Buffer.byteLength(supplied)||!timingSafeEqual(Buffer.from(expected),Buffer.from(supplied)))return r.status(403).json({error:'SSO_CONSUMER_DENIED'});
 try{r.set('Cache-Control','no-store');r.json(service.inspect(q));}catch(e){r.status(e.status||503).json({error:e.code||'SSO_UNAVAILABLE'});}
});
app.use((q,r,next)=>{
 r.set('Cache-Control','no-store');r.set('X-Content-Type-Options','nosniff');
 if(config.origins.includes(q.headers.origin)){r.set('Access-Control-Allow-Origin',q.headers.origin);r.set('Access-Control-Allow-Credentials','true');r.set('Vary','Origin');}
 if(q.method==='OPTIONS'){if(!config.origins.includes(q.headers.origin))return r.sendStatus(403);r.set('Access-Control-Allow-Methods','POST, OPTIONS');r.set('Access-Control-Allow-Headers','Content-Type, X-Izone-Csrf');return r.sendStatus(204);}
 if(q.path==='/health')return next();
 if(!config.origins.includes(q.headers.origin)||q.headers['x-izone-csrf']!=='1')return r.status(403).json({error:'SSO_ORIGIN_DENIED'});
 next();
});
app.use(rateLimit({windowMs:60000,limit:240,standardHeaders:'draft-8',legacyHeaders:false}));
app.use(express.json({limit:'12kb'}));
const wrap=fn=>async(q,r,next)=>{try{r.json(await fn(q,r));}catch(e){next(e);}};
app.post('/v1/source/:id',wrap((q,r)=>{if(Object.keys(q.body||{}).some(k=>k!=='replace')||q.body?.replace!==undefined&&typeof q.body.replace!=='boolean')throw Object.assign(Error(),{status:400,code:'SSO_INPUT_INVALID'});return service.bridge(q,r,q.params.id,q.body||{});}));
app.post('/v1/restore/:id',wrap((q,r)=>service.restore(q,r,q.params.id)));
app.post('/v1/logout',wrap((q,r)=>service.logout(q,r)));
app.post('/v1/login/:product',wrap(async(q,r)=>{
 const source=sources[q.params.product],body=q.body;
 if(!source?.googleClientId||source.kind!=='identity'||!body||typeof body.credential!=='string'||body.credential.length>8192||Object.keys(body).some(k=>!['credential','remember'].includes(k))||body.remember!==undefined&&typeof body.remember!=='boolean')throw Object.assign(Error(),{status:400,code:'SSO_INPUT_INVALID'});
 let payload;try{payload=await verifyGoogleToken(body.credential,source.googleClientId);}catch{throw Object.assign(Error(),{status:401,code:'SSO_GOOGLE_INVALID'});}
 return service.login(q,r,payload,body.remember!==false);
}));
app.get('/health',(_q,r)=>r.json({ok:true,products:Object.keys(sources),revision:config.revision}));
app.use((error,_q,r,_next)=>r.status(error.status||503).json({error:error.code||'SSO_UNAVAILABLE'}));
return app;
}
