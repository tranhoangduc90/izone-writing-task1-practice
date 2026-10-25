// Own Shops database binding -> pinned snapshot in its separate writer.
import {ApiError} from '../../src/service.js';
import {createLmsResultService,normalizeLmsResult} from '../../src/lms-result-service.js';
const engine='sw-task2-writing56-67-preview-20261025.1';
const base='https://ducizone.ddns.net/sw-task2-preview-api/results';
const assets='https://tranhoangduc90.github.io/izone-ai-team-pages/sw-task2-preview-20261025';
export function createShopsResults({pool,fetchImpl=fetch}){
 const legacy=createLmsResultService({pool,fetchImpl});
 async function snapshot(row){
  const a=row.artifacts,id=a.writerGroupId,v=a.writerVersion;
  if(a.gradingEngine!==engine||a.readbackOk!==true||!/^[a-f0-9]{48}$/.test(id||'')||!Number.isSafeInteger(v)||v<1||a.lmsUrl!==`${base}/shared/writing-essays/${id}/view?v=${v}`)throw new ApiError(502,'SHOPS_RESULT_BINDING','Kết quả chưa được đối chiếu đầy đủ.');
  const response=await fetchImpl(`http://sw-task2-preview-writer:8780/writing-data/${id}/v${String(v).padStart(6,'0')}.json`,{signal:AbortSignal.timeout(8000),redirect:'error'});
  if(!response.ok||Number(response.headers.get('content-length'))>4*1024*1024)throw new ApiError(502,'SHOPS_RESULT_UNAVAILABLE','Tạm thời chưa đọc được kết quả.');
  const bytes=await response.arrayBuffer();if(bytes.byteLength>4*1024*1024)throw new ApiError(502,'SHOPS_RESULT_TOO_LARGE','Kết quả vượt giới hạn.');
  const raw=JSON.parse(Buffer.from(bytes).toString());
  if(raw.meta?.id!==id||raw.meta.version!==v||raw.essays?.length!==a.correctionsCount)throw new ApiError(502,'SHOPS_RESULT_CHANGED','Kết quả không khớp phiên bản đã chấm.');
  const result=normalizeLmsResult(raw);
  return {...result,updatedAt:row.updatedAt,noCorrections:a.noCorrections===true&&result.essays.length===0,readbackOk:true,reviewCaseCount:a.atomicReviewCases?.length||0};
 }
 async function getDraftResult({sessionRef}){
  const result=await pool.query(`SELECT attempt.result_artifacts AS artifacts,attempt.completed_at AS "updatedAt"
   FROM writing_practice.activity_session s JOIN writing_practice.check_attempt attempt ON attempt.session_id=s.id
   WHERE s.public_id=$1 AND attempt.section_key='draft' AND attempt.status='completed' AND attempt.result_status='passed'
   ORDER BY attempt.completed_at DESC NULLS LAST,attempt.id DESC LIMIT 1`,[sessionRef]);
  if(result.rows[0]?.artifacts?.gradingEngine===engine)return snapshot(result.rows[0]);
  return legacy.getDraftResult({sessionRef});
 }
 async function byCapability(id,version){
  if(!/^[a-f0-9]{48}$/.test(id)||!Number.isSafeInteger(version)||version<1)throw new ApiError(404,'NOT_FOUND','Không tìm thấy kết quả.');
  const result=await pool.query(`SELECT result_artifacts AS artifacts,completed_at AS "updatedAt" FROM writing_practice.check_attempt
   WHERE status='completed' AND result_status='passed' AND result_artifacts->>'gradingEngine'=$1 AND result_artifacts->>'writerGroupId'=$2 AND result_artifacts->>'writerVersion'=$3 LIMIT 1`,[engine,id,String(version)]);
  if(!result.rowCount)throw new ApiError(404,'NOT_FOUND','Không tìm thấy kết quả.');return snapshot(result.rows[0]);
 }
 return {getDraftResult,byCapability};
}
export function installShopsResultRoutes(app,results){
 const safe=fn=>(q,r,n)=>Promise.resolve(fn(q,r)).catch(n);
 app.get('/results/result-view.mjs',(_q,r)=>r.type('text/javascript').send(`import {renderLmsDraftResult} from '${assets}/writing-handouts/js/lms-draft-result.js';
 const root=document.getElementById('result');
 try {const response=await fetch(location.pathname+'/data'+location.search);if(!response.ok)throw Error();const data=await response.json();renderLmsDraftResult(root,data,{updatedAt:data.updatedAt});}catch{root.textContent='Tạm thời chưa tải được kết quả. Em hãy mở lại sau.';}`));
 app.get('/results/shared/writing-essays/:id/view/data',safe(async(q,r)=>r.json(await results.byCapability(q.params.id,Number(q.query.v)))));
 app.get('/results/shared/writing-essays/:id/view',safe(async(q,r)=>{
  await results.byCapability(q.params.id,Number(q.query.v));
  r.set('Content-Security-Policy',"default-src 'self'; script-src 'self' https://tranhoangduc90.github.io; style-src 'self' https://tranhoangduc90.github.io; connect-src 'self'; font-src https://tranhoangduc90.github.io; object-src 'none'; base-uri 'none'; form-action 'none'");
  r.type('html').send(`<!doctype html><html lang="vi" data-izone-theme="master170"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>SW Task 2 · Nhận xét từng câu</title><link rel="stylesheet" href="${assets}/writing-handouts/lesson5-demo/theme.css"><link rel="stylesheet" href="${assets}/shared/master170/theme.css"><link rel="stylesheet" href="${assets}/shared/master170/handout.css"><link rel="stylesheet" href="${assets}/writing-handouts/shops-review/connected-result.css"><script type="module" src="/sw-task2-preview-api/results/result-view.mjs"></script></head><body data-m170-product="handout"><main class="shops-result-page"><h1>Nhận xét từng câu</h1><div id="result" role="region" aria-label="Kết quả chấm">Đang tải nhận xét…</div></main></body></html>`);
 }));
}
