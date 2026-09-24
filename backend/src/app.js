import crypto from 'node:crypto';
import express from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { z } from 'zod';
import { ApiError } from './service.js';
import { createTeacherClassAccessService, reviewerIsAdmin } from './teacher-class-access.js';
import { writingFlowRequestLog } from './writing-flow-observability.js';

const uuid=z.string().uuid(), section=z.enum(['overview','outline','draft']);
const lessonSection=z.string().regex(/^[a-z0-9][a-z0-9_]{1,79}$/);
const responseMap=z.record(z.string().regex(/^[a-z0-9][a-z0-9_]{1,79}$/),z.string().max(20_000)).superRefine((value,context)=>{
 if(Object.keys(value).length>40)context.addIssue({code:'custom',message:'Quá nhiều ô bài làm.'});
});
const meaningfulText = (value) => value.replace(/[\s\u200B-\u200D\u2060\uFEFF]/gu, '');
const draft=z.object({overview:z.string().max(20_000),body1:z.string().max(20_000),body2:z.string().max(20_000),draft1:z.string().max(20_000).optional(),draft2:z.string().max(20_000).optional(),draft2Unlocked:z.boolean().optional()});
const activitySlug=z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/);
const open=z.object({activitySlug,classRef:uuid,studentRef:uuid,accessCode:z.string().regex(/^\d{4}$/).optional()});
const provisionalCreate=z.object({classRef:uuid,displayName:z.string().min(2).max(100),pin:z.string().regex(/^\d{4}$/),requestId:uuid,duplicateConfirmed:z.boolean().default(false)});
const reconcile=z.object({officialStudentRef:uuid});
const studentSearch=z.object({q:z.string().trim().min(2).max(100),excludeStudentRef:uuid.optional(),limit:z.coerce.number().int().min(1).max(20).default(20)});
const save=z.object({baseVersion:z.number().int().min(0),requestId:uuid,...draft.shape});
const check=z.object({section,requestId:uuid,snapshot:draft}).superRefine((value,context)=>{
 if(value.section==='overview'&&!meaningfulText(value.snapshot.overview))context.addIssue({code:'custom',path:['snapshot','overview'],message:'Overview trống.'});
 if(value.section==='outline'&&!meaningfulText(value.snapshot.body1)&&!meaningfulText(value.snapshot.body2))context.addIssue({code:'custom',path:['snapshot'],message:'Outline trống.'});
 if(value.section==='draft'&&(!meaningfulText(value.snapshot.draft1||'')||!meaningfulText(value.snapshot.draft2||'')))context.addIssue({code:'custom',path:['snapshot'],message:'Draft 1 và Draft 2 không được để trống.'});
});
// maxJobs chỉ giới hạn kích thước một response để bảo vệ API; số job đang chấm đồng thời do n8n kiểm soát.
const claim=z.object({workerId:z.string().trim().min(1).max(100),maxJobs:z.number().int().min(1).max(100).default(1),leaseSeconds:z.literal(420),workerPool:z.string().regex(/^[a-z0-9][a-z0-9_-]{1,49}$/).default('task1')});
const gradingResult=z.enum(['passed','needs_revision']);
const complete=z.object({leaseToken:uuid,resultStatus:gradingResult.optional(),status:gradingResult.optional(),feedback:z.string().trim().min(1).max(20_000),artifacts:z.record(z.string(),z.unknown()).optional()})
 .superRefine((value,context)=>{if(!value.resultStatus&&!value.status)context.addIssue({code:'custom',path:['status'],message:'Thiếu kết quả chấm.'});})
 .transform(value=>({...value,resultStatus:value.resultStatus||value.status}));
const fail=z.object({leaseToken:uuid,errorCode:z.string().trim().min(1).max(100),retryable:z.boolean()});
const reopen=z.object({reason:z.string().trim().min(3).max(500)});
const lessonSave=z.object({baseVersion:z.number().int().min(0),requestId:uuid,responses:responseMap});
const lessonCheck=z.object({section:lessonSection,requestId:uuid});
const liveUpdate=z.object({activeField:lessonSection.nullable().optional()});
const teacherCommentBody=z.string().trim().min(1).max(5000);
const teacherCommentCreate=z.object({sectionKey:lessonSection,fieldKey:lessonSection,start:z.number().int().min(0),end:z.number().int().positive(),baseVersion:z.number().int().min(0),body:teacherCommentBody,requestId:uuid})
 .superRefine((value,context)=>{if(value.end<=value.start||value.end-value.start>2000)context.addIssue({code:'custom',path:['end'],message:'Đoạn comment không hợp lệ.'});});
const teacherCommentReply=z.object({body:teacherCommentBody,requestId:uuid});
const teacherCommentStatus=z.object({status:z.enum(['open','addressed']),requestId:uuid});
const writingSourceType=z.enum(['lark_homework','google_classroom','manual','term_test']);
const writingPairIntake=z.object({
 sourceType:writingSourceType.default('lark_homework'),
 sourceId:uuid.nullable().optional(),
 operationKey:z.string().trim().min(1).max(120),
 appId:z.string().trim().min(1).max(120),
 tableId:z.string().trim().min(1).max(120),
 recordId:z.string().trim().min(1).max(120),
 docId:z.string().trim().min(1).max(160),
 linkIndex:z.number().int().min(1).max(100),
 classCode:z.string().trim().min(1).max(80),
 larkMeta:z.object({classCode:z.string().trim().min(1).max(80),imageUrls:z.object({
   1:z.string().max(20000),2:z.string().max(20000),
   3:z.string().max(20000),4:z.string().max(20000)
 })}).nullable().optional(),
 sourceMeta:z.object({
   displayName:z.string().trim().max(200).nullable().optional(),
   studentName:z.string().trim().max(200).nullable().optional(),
   teacherNames:z.array(z.string().trim().min(1).max(200)).max(20).default([]),
   classroomUrl:z.string().url().max(2000).nullable().optional(),
   fileUrl:z.string().url().max(2000).nullable().optional(),
   sourceStatus:z.string().trim().max(80).nullable().optional(),
   sourceCreatedAt:z.string().datetime({offset:true}).nullable().optional(),
   testConfig:z.string().trim().max(120).nullable().optional(),
   note:z.string().trim().max(1000).nullable().optional(),
   createdBy:z.string().trim().max(200).nullable().optional()
 }).default({teacherNames:[]}),
 sourceModifiedAt:z.string().trim().min(1).max(80),
 larkModifiedMs:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable().optional(),
 documentKind:z.enum(['google_docs','docx']),
 verifiedMime:z.string().trim().min(1).max(160),
 expectedCount:z.number().int().min(1).max(4),
 pairs:z.array(z.object({
   essaySlot:z.number().int().min(1).max(4),
   taskType:z.enum(['task_1','task_2']),
   topic:z.string().max(20000), image:z.string().max(20000),
   essay:z.string().max(40000), trCcCheck:z.boolean(), alreadyGraded:z.boolean().default(false),
   revision:z.string().regex(/^[0-9a-f]{64}$/).optional(),
   contentSha256:z.string().regex(/^[0-9a-f]{64}$/).optional()
 })).min(1).max(4)
}).superRefine((value,context)=>{
 if(value.sourceType==='lark_homework'&&!value.larkMeta){
   context.addIssue({code:'custom',path:['larkMeta'],message:'Nguồn Lark thiếu metadata.'});
 }
 if(value.sourceType==='lark_homework'&&!value.larkModifiedMs){
   context.addIssue({code:'custom',path:['larkModifiedMs'],message:'Nguồn Lark thiếu thời điểm sửa.'});
 }
 if(value.sourceType==='manual'&&value.classCode!=='MANUAL'){
   context.addIssue({code:'custom',path:['classCode'],message:'Nguồn thủ công phải dùng lớp MANUAL.'});
 }
});
const writingSourceIssue=z.object({
 appId:z.string().trim().min(1).max(120),
 tableId:z.string().trim().min(1).max(120),
 recordId:z.string().trim().min(1).max(120),
 docId:z.string().trim().min(1).max(160).nullable().default(null),
 linkIndex:z.number().int().min(1).max(100).nullable().default(null),
 essaySlot:z.number().int().min(1).max(4).nullable().default(null),
 classCode:z.string().trim().min(1).max(80).nullable().default(null),
 reasonCode:z.enum(['FILE_TYPE_UNSUPPORTED','FETCH_FAILED','PARSER_FAILED',
   'MIME_UNVERIFIED','SOURCE_METADATA_MISSING','SOURCE_LINK_INVALID','CLASS_MISSING',
   'SOURCE_CHANGED_DURING_SCAN','TITLE_WRITING','VIETNAMESE_WRITING','TOPIC_NOT_FOUND',
    'NOT_WRITING_DOCUMENT','TOPIC_NOT_IN_REGISTRY','TOPIC_REGISTRY_UNAVAILABLE',
    'TOPIC_REGISTRY_AMBIGUOUS','TOPIC_IMAGE_MISSING','ESSAY_ANCHOR_MISSING',
   'ESSAY_CELL_MISSING','TEACHER_COMMENT_ANCHOR_MISSING','RESULT_CELL_AMBIGUOUS',
   'TABLE_STRUCTURE_INVALID','NO_ESSAY',
   'INTAKE_TOPIC_MISSING','INTAKE_CHART_LINK_INVALID',
   'INTAKE_CHART_LINK_AMBIGUOUS','INTAKE_TASK_TYPE_MISMATCH'])
});
const writingScanItem=z.object({
 recordId:z.string().trim().min(1).max(120),
 docId:z.string().trim().min(1).max(160).nullable(),
 linkIndex:z.number().int().min(1).max(100),
 classCode:z.string().trim().min(1).max(80).nullable().optional()
});
const writingScanBegin=z.object({
 requestKey:z.string().trim().min(1).max(160),appId:z.string().trim().min(1).max(120),
 tableId:z.string().trim().min(1).max(120),
 scannedThroughAt:z.string().trim().min(1).max(80),
 pageCount:z.number().int().min(1).max(10000),reachedEnd:z.literal(true),
 items:z.array(writingScanItem).max(20000)
});
const writingScanAck=z.object({
 runId:uuid,itemKey:z.string().regex(/^[0-9a-f]{64}$/),
 status:z.enum(['accepted','partial','issue','excluded','empty']),
 pairIds:z.array(uuid).max(4).default([]),
 issueKeys:z.array(z.string().regex(/^[0-9a-f]{64}$/)).max(4).default([]),
 detectedSlotCount:z.number().int().min(0).max(4).nullable().default(null),
 exclusionCode:z.enum(['CLASS_EXCLUDED','NON_WRITING_TITLE','NON_WRITING_DOCUMENT',
   'FILE_TYPE_UNSUPPORTED']).nullable().default(null)
});
const writingScanCursor=z.object({
 appId:z.string().trim().min(1).max(120),tableId:z.string().trim().min(1).max(120)
});
const writingScanClosure=writingScanCursor.extend({
 recordId:z.string().trim().min(1).max(120)
});
const writingScanClosureComplete=writingScanClosure.extend({
 runId:uuid,finishedAtMs:z.number().int().positive().safe(),
 observations:z.array(z.object({
  linkIndex:z.number().int().min(1).max(100),
  docId:z.string().trim().min(1).max(160),
  status:z.enum(['accepted','empty']),
  observedAtMs:z.number().int().positive().safe(),
  receiptRequest:z.object({expectedPairs:z.array(z.object({
   essaySlot:z.number().int().min(1).max(4),
   revision:z.string().regex(/^[0-9a-f]{64}$/),
   contentSha256:z.string().regex(/^[0-9a-f]{64}$/).optional(),
   trCcCheck:z.boolean().optional()
  })).max(4)}).optional()
 })).max(100)
});
const writingScanReceipts=z.object({
 appId:z.string().trim().min(1).max(120),tableId:z.string().trim().min(1).max(120),
 recordId:z.string().trim().min(1).max(120),docId:z.string().trim().min(1).max(160).nullable(),
 linkIndex:z.number().int().min(1).max(100),
 expectedPairs:z.array(z.object({essaySlot:z.number().int().min(1).max(4),
   revision:z.string().regex(/^[0-9a-f]{64}$/),
   contentSha256:z.string().regex(/^[0-9a-f]{64}$/).optional(),
   trCcCheck:z.boolean().optional()})).max(4),
 expectedIssues:z.array(z.object({essaySlot:z.number().int().min(1).max(4).nullable(),
   reasonCode:z.string().trim().min(1).max(100)})).max(4)
}).superRefine((value,context)=>{
 const slots=[...value.expectedPairs.map(pair=>pair.essaySlot),
   ...value.expectedIssues.map(issue=>issue.essaySlot)];
 if(slots.length===0||slots.length>4||new Set(slots).size!==slots.length){
   context.addIssue({code:'custom',message:'Danh sách ô cần đối chiếu không hợp lệ.'});
 }
});
const writingScanPrepare=z.object({
 runId:uuid,itemKey:z.string().regex(/^[0-9a-f]{64}$/),
 status:z.enum(['accepted','partial','issue']),
 detectedSlotCount:z.number().int().min(0).max(4).nullable(),
 receiptRequest:writingScanReceipts
});
const writingStage=z.enum(['intake','precheck','main','critic','arbiter','render','deliver']);
const writingClaim=z.object({pairId:uuid,revision:z.string().regex(/^[0-9a-f]{64}$/),
 stageKey:writingStage,handoffId:uuid,executionId:z.string().trim().min(1).max(80)});
const writingComplete=z.object({pairId:uuid,revision:z.string().regex(/^[0-9a-f]{64}$/),
 stageKey:writingStage,attemptId:uuid,result:z.record(z.string(),z.unknown()),
 nextStage:writingStage.nullable().default(null)});
const writingFail=z.object({pairId:uuid,revision:z.string().regex(/^[0-9a-f]{64}$/),
 stageKey:writingStage,attemptId:uuid,errorCode:z.string().trim().min(1).max(100),
 unknown:z.boolean().default(false)});
const writingTrccRepairClaim=z.object({pairId:uuid,
 revision:z.string().regex(/^[0-9a-f]{64}$/),handoffId:uuid,
 executionId:z.string().trim().min(1).max(80)});
const writingTrccRepairComplete=z.object({pairId:uuid,
 revision:z.string().regex(/^[0-9a-f]{64}$/),repairAttemptId:uuid,
 operationKey:z.string().trim().min(1).max(160),
 result:z.object({text:z.string().trim().min(1).max(80000),
   promptKey:z.string().trim().min(1).max(160),provider:z.string().trim().max(100).nullable().optional(),
   route:z.string().trim().max(100).nullable().optional()})});
const writingTrccRepairFail=z.object({pairId:uuid,
 revision:z.string().regex(/^[0-9a-f]{64}$/),repairAttemptId:uuid,
 errorCode:z.string().trim().min(1).max(100),unknown:z.boolean().default(false)});
const writingAiStage=z.enum(['precheck','main','critic','arbiter']);
// Nhóm chấm thường dùng 0–100; lượt sửa JSON dùng 1.000.000 + chỉ số nhóm gốc.
// Giữ hai dải tách biệt để mã lỗi hoặc giá trị ngoài phạm vi không lọt vào database.
const writingAiBatchIndex=z.union([
 z.number().int().min(0).max(100),
 z.number().int().min(1_000_000).max(1_000_100)
]);
const writingAiBase={pairId:uuid,revision:z.string().regex(/^[0-9a-f]{64}$/),
 stageKey:writingAiStage,attemptId:uuid,batchIndex:writingAiBatchIndex};
const writingAiStart=z.object({...writingAiBase,prompt:z.string().min(1).max(100000)});
const writingAiFinish=z.object({...writingAiBase,operationKey:z.string().trim().min(1).max(160),
 outcome:z.enum(['succeeded','failed','unknown']),gatewayOperationId:uuid.nullable().optional(),
 provider:z.string().trim().max(100).nullable().optional(),route:z.string().trim().max(100).nullable().optional(),
 result:z.record(z.string(),z.unknown()).nullable().optional(),errorCode:z.string().trim().max(100).nullable().optional()});
const writingWorkflowFailure=z.object({
 workflowId:z.string().regex(/^[A-Za-z0-9_-]{1,80}$/),
 workflowName:z.string().trim().min(1).max(160),
 executionId:z.string().regex(/^(?:[0-9]{1,20}|trigger-[0-9]{1,20})$/),
 lastNode:z.string().trim().min(1).max(160),
 errorKind:z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,99}$/)
});
const writingManualSource=z.object({
 displayName:z.string().trim().min(2).max(200),
 documentUrl:z.string().url().max(2000),
 kind:z.enum(['homework','test']).default('homework'),
 testConfig:z.string().trim().min(2).max(120).nullable().default(null),
 topology:z.enum(['task_2_only','task_1_and_task_2']).nullable().default(null),
 note:z.string().trim().max(1000).nullable().default(null),
 requestId:uuid
}).superRefine((value,context)=>{
 if(value.kind==='test'&&(!value.testConfig||!value.topology)){
   context.addIssue({code:'custom',path:['testConfig'],message:'Bài Test cần cấu hình và số Task.'});
 }
});
const writingSourceAck=z.object({
 sourceId:uuid,outcome:z.enum(['accepted','issue','excluded']),
 errorCode:z.string().trim().min(1).max(100).nullable().default(null)
});
const writingOperatorAction=z.object({
 requestId:uuid,reason:z.string().trim().min(2).max(500)
});
const writingStageRetry=writingOperatorAction.extend({stageKey:writingStage});
const writingClassRegistryItem=z.object({
 classCode:z.string().trim().min(1).max(80),courseId:z.string().trim().min(1).max(120),
 courseName:z.string().trim().max(300).nullable().optional(),cohort:z.string().trim().max(120).nullable().optional(),
 teacherNames:z.array(z.string().trim().min(1).max(200)).max(20).default([]),enabled:z.boolean().default(true)
});
const writingClassroomSource=z.object({
 courseId:z.string().trim().min(1).max(120),submissionId:z.string().trim().min(1).max(160),
 googleUserId:z.string().trim().min(1).max(160).optional(),
 courseWorkId:z.string().trim().min(1).max(160),documentId:z.string().trim().min(20).max(160),
 linkIndex:z.number().int().min(1).max(20),displayName:z.string().trim().max(300).nullable().optional(),
 classCode:z.string().trim().min(1).max(80),studentName:z.string().trim().max(200).nullable().optional(),
 teacherNames:z.array(z.string().trim().min(1).max(200)).max(20).default([]),
 classroomUrl:z.string().url().max(2000).nullable().optional(),fileUrl:z.string().url().max(2000),
 sourceStatus:z.string().trim().max(80).nullable().optional(),
 sourceCreatedAt:z.string().datetime({offset:true}).nullable().optional(),
 sourceUpdatedAt:z.string().datetime({offset:true})
});
const writingLegacyItem=z.object({
 appId:z.string().trim().min(1).max(120),tableId:z.string().trim().min(1).max(120),
 recordId:z.string().trim().min(1).max(160),essaySlot:z.number().int().min(1).max(4).nullable().optional(),
 classCode:z.string().trim().max(80).nullable().optional(),studentName:z.string().trim().max(200).nullable().optional(),
 teacherName:z.string().trim().max(200).nullable().optional(),sourceStatus:z.string().trim().max(80).nullable().optional(),
 createdAt:z.string().datetime({offset:true}).nullable().optional(),finishedAt:z.string().datetime({offset:true}).nullable().optional(),
 snapshot:z.record(z.string(),z.unknown())
});
const parse=(schema,value,code='INVALID_REQUEST')=>{const r=schema.safeParse(value);if(!r.success)throw new ApiError(400,code,'Dữ liệu gửi lên không hợp lệ.');return r.data;};
const asyncRoute=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
function sameSecret(actual,expected){const a=Buffer.from(String(actual||'')),b=Buffer.from(String(expected||''));return a.length>0&&a.length===b.length&&crypto.timingSafeEqual(a,b);}

// Dữ liệu vào: mã phiên/lượt chấm/học viên do route nhận; handler phía sau vẫn chịu trách nhiệm kiểm định dạng và quyền.
// Việc chính: chọn một khóa ổn định theo đúng đối tượng nghiệp vụ; không dùng requestId vì mỗi lần lưu có mã mới.
// Kết quả: nhiều học viên dùng chung Wi-Fi không tranh cùng một quota ghi.
// Khi thiếu identity: quay về khóa IP với trần dự phòng cao hơn, không bỏ hoàn toàn lớp chống quá tải.
export function writingRateIdentity(req = {}) {
  const candidates = [
    ['session', req.params?.sessionRef],
    ['attempt', req.params?.attemptRef],
    ['student', req.params?.studentRef],
    ['student', req.body?.studentRef],
  ];
  const match = candidates.find(([, value]) => typeof value === 'string' && value.trim());
  return match ? `${match[0]}:${match[1].trim()}` : '';
}

export function writingWriteRateKey(req) {
  const identity = writingRateIdentity(req);
  if (identity) {
    return `identity:${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`;
  }
  return `ip:${ipKeyGenerator(req.ip)}`;
}

export function writingWriteRateLimit(req) {
  return writingRateIdentity(req) ? 240 : 2_000;
}
function cors(config){return(req,res,next)=>{const origin=req.get('origin');if(origin&&!config.allowedOrigins.has(origin))return res.status(403).json({ok:false,error:'ORIGIN_NOT_ALLOWED'});if(origin){res.set('Access-Control-Allow-Origin',origin);res.set('Vary','Origin');}res.set('Access-Control-Allow-Credentials','true');res.set('Access-Control-Allow-Methods','GET, POST, PUT, DELETE, OPTIONS');res.set('Access-Control-Allow-Headers','Authorization, Content-Type, If-None-Match, If-Match, x-izone-csrf');res.set('Access-Control-Expose-Headers','ETag, Retry-After, X-Writing-Request-Id');res.set('Cache-Control','no-store');return req.method==='OPTIONS'?res.status(204).end():next();};}
function csvCell(value){const text=String(value??'');return /[",\r\n]/.test(text)?`"${text.replaceAll('"','""')}"`:text;}

export function createApp({config,pool,service,lessonService=service,provisionalService=null,lmsResultService=null,teacherCommentService=null,teacherClassAccess=null,writingFlowService=null,writingFlowStage=null,writingFlowHandoff=null,writingFlowAiCall=null,writingFlowScan=null,writingFlowTrccRepair=null,teacherAuth=null,adminAuth=(_q,r)=>r.status(503).json({ok:false,error:'ADMIN_AUTH_NOT_CONFIGURED'})}){
 const app=express();app.disable('x-powered-by');app.set('trust proxy',config.trustProxyHops);
 // Ghi mã truy vết trước khi CORS hoặc giới hạn tốc độ chặn yêu cầu Writing.
 app.use('/api/v1/internal/writing-flow',writingFlowRequestLog());
 app.use('/api/v1/admin/writing-flow',writingFlowRequestLog());
 app.use(helmet());app.use(cors(config));
 const classAccess=teacherClassAccess||createTeacherClassAccessService({pool});
 const teacherManage=(q,r,next)=>q.reviewer?.canManage===true?next():r.status(403).json({ok:false,error:'MANAGE_PERMISSION_REQUIRED'});
 const writingFlowAdmin=(q,r,next)=>reviewerIsAdmin(q.reviewer)?next():r.status(403).json({ok:false,error:'ADMIN_PERMISSION_REQUIRED'});
 const writingFlowReady=(q,r,next)=>writingFlowService?next():r.status(503).json({ok:false,error:'WRITING_FLOW_NOT_READY'});
 const writingStageReady=(q,r,next)=>writingFlowStage?next():r.status(503).json({ok:false,error:'WRITING_STAGE_NOT_READY'});
 const writingHandoffReady=(q,r,next)=>writingFlowHandoff?next():r.status(503).json({ok:false,error:'WRITING_HANDOFF_NOT_READY'});
 const writingAiReady=(q,r,next)=>writingFlowAiCall?next():r.status(503).json({ok:false,error:'WRITING_AI_CALL_NOT_READY'});
 const writingScanReady=(q,r,next)=>writingFlowScan?next():r.status(503).json({ok:false,error:'WRITING_SCAN_NOT_READY'});
 const writingTrccRepairReady=(q,r,next)=>writingFlowTrccRepair?next():r.status(503).json({ok:false,error:'WRITING_TRCC_REPAIR_NOT_READY'});
 const dashboardScope=q=>({reviewerEmail:q.reviewer.email,canAccessAllClasses:reviewerIsAdmin(q.reviewer)});
 // Một lớp có thể dùng chung một địa chỉ mạng. Ngưỡng đọc này vẫn chịu được 40 học viên polling 2 giây/lần.
 app.use(rateLimit({windowMs:60_000,limit:2400,standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,error:'RATE_LIMITED'}}));
 app.use('/api/v1/internal/writing-flow',express.json({limit:'512kb',strict:true}));
 app.use(express.json({limit:'96kb',strict:true}));
 app.get('/health',(_q,r)=>r.json({ok:true}));app.get('/ready',asyncRoute(async(_q,r)=>{await pool.query('SELECT 1');r.json({ok:true});}));
 const authLoginLimiter=rateLimit({windowMs:10*60_000,limit:20,standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,error:'RATE_LIMITED'}});
 const authReady=(_q,r)=>r.status(503).json({ok:false,error:'ADMIN_AUTH_NOT_CONFIGURED'});
 app.post('/api/v1/auth/session',authLoginLimiter,asyncRoute(teacherAuth?.login||authReady));
 app.get('/api/v1/auth/session',adminAuth,asyncRoute(async(q,r)=>r.json({ok:true,reviewer:q.reviewer})));
 app.delete('/api/v1/auth/session',adminAuth,asyncRoute(teacherAuth?.logout||authReady));
 // Hai lớp: mỗi phiên có quota riêng, đồng thời toàn bộ request ghi từ một IP vẫn có trần chống lạm dụng.
 const writes=[
  rateLimit({windowMs:60_000,limit:2_000,keyGenerator:q=>ipKeyGenerator(q.ip),standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,error:'RATE_LIMITED'}}),
  rateLimit({windowMs:60_000,limit:writingWriteRateLimit,keyGenerator:writingWriteRateKey,standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,error:'RATE_LIMITED'}}),
 ];
 const lmsReads=rateLimit({windowMs:60_000,limit:240,standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,error:'LMS_RESULT_RATE_LIMITED'}});
 const provisionalWrites=rateLimit({windowMs:10*60_000,limit:60,standardHeaders:'draft-8',legacyHeaders:false,message:{ok:false,error:'PROVISIONAL_REGISTRATION_RATE_LIMITED'}});
 app.get('/api/v1/activities/:slug/roster',asyncRoute(async(q,r)=>r.json({ok:true,...await service.getRoster(q.params.slug)})));
 app.post('/api/v1/activities/:slug/provisional-students',provisionalWrites,asyncRoute(async(q,r)=>{
   if(!provisionalService)throw new ApiError(503,'PROVISIONAL_STUDENTS_NOT_CONFIGURED','Chức năng học viên tạm chưa được cấu hình.');
   r.status(201).json({ok:true,student:await provisionalService.createStudent({activitySlug:parse(activitySlug,q.params.slug),...parse(provisionalCreate,q.body)})});
 }));
 app.post('/api/v1/sessions',writes,asyncRoute(async(q,r)=>r.status(201).json({ok:true,session:await service.openSession(parse(open,q.body))})));
 app.get('/api/v1/sessions/:sessionRef',asyncRoute(async(q,r)=>r.json({ok:true,session:await service.sessionDetails(parse(uuid,q.params.sessionRef))})));
 app.get('/api/v1/sessions/:sessionRef/draft-result',lmsReads,asyncRoute(async(q,r)=>{
   if(!lmsResultService)throw new ApiError(503,'LMS_RESULT_NOT_CONFIGURED','Kết quả LMS chưa được cấu hình.');
   r.json({ok:true,result:await lmsResultService.getDraftResult({sessionRef:parse(uuid,q.params.sessionRef)})});
 }));
 app.put('/api/v1/sessions/:sessionRef/draft',writes,asyncRoute(async(q,r)=>r.json({ok:true,session:await service.saveDraft({sessionRef:parse(uuid,q.params.sessionRef),...parse(save,q.body)})})));
 app.post('/api/v1/sessions/:sessionRef/checks',writes,asyncRoute(async(q,r)=>r.status(202).json({ok:true,attempt:await service.submitCheck({sessionRef:parse(uuid,q.params.sessionRef),...parse(check,q.body)})})));
 app.put('/api/v1/sessions/:sessionRef/live',writes,asyncRoute(async(q,r)=>r.json({ok:true,...await service.publishLive({sessionRef:parse(uuid,q.params.sessionRef)})})));
 app.post('/api/v1/lesson-sessions',writes,asyncRoute(async(q,r)=>r.status(201).json({ok:true,session:await lessonService.openSession(parse(open,q.body))})));
 app.get('/api/v1/lesson-sessions/:sessionRef',asyncRoute(async(q,r)=>r.json({ok:true,session:await lessonService.sessionDetails(parse(uuid,q.params.sessionRef))})));
 app.get('/api/v1/lesson-sessions/:sessionRef/draft-result',lmsReads,asyncRoute(async(q,r)=>{
   if(!lmsResultService)throw new ApiError(503,'LMS_RESULT_NOT_CONFIGURED','Kết quả LMS chưa được cấu hình.');
   r.json({ok:true,result:await lmsResultService.getDraftResult({sessionRef:parse(uuid,q.params.sessionRef)})});
 }));
 app.put('/api/v1/lesson-sessions/:sessionRef/responses',writes,asyncRoute(async(q,r)=>r.json({ok:true,session:await lessonService.saveResponses({sessionRef:parse(uuid,q.params.sessionRef),...parse(lessonSave,q.body)})})));
 app.post('/api/v1/lesson-sessions/:sessionRef/checks',writes,asyncRoute(async(q,r)=>r.status(202).json({ok:true,attempt:await lessonService.submitCheck({sessionRef:parse(uuid,q.params.sessionRef),...parse(lessonCheck,q.body)})})));
 app.put('/api/v1/lesson-sessions/:sessionRef/live',writes,asyncRoute(async(q,r)=>r.json({ok:true,...await lessonService.publishLive({sessionRef:parse(uuid,q.params.sessionRef),...parse(liveUpdate,q.body)})})));
 const commentsReady=()=>{if(!teacherCommentService)throw new ApiError(503,'TEACHER_COMMENTS_NOT_CONFIGURED','Comment giảng viên chưa được cấu hình.');return teacherCommentService;};
 app.get('/api/v1/sessions/:sessionRef/teacher-comments',asyncRoute(async(q,r)=>{const data=await commentsReady().list({sessionRef:parse(uuid,q.params.sessionRef)});const tag=`"teacher-comments-${data.version}"`;if(q.get('if-none-match')===tag)return r.status(304).end();r.set('ETag',tag);return r.json({ok:true,threads:data.threads});}));
 app.post('/api/v1/sessions/:sessionRef/teacher-comments/:threadRef/replies',writes,asyncRoute(async(q,r)=>r.status(201).json({ok:true,thread:await commentsReady().reply({threadRef:parse(uuid,q.params.threadRef),sessionRef:parse(uuid,q.params.sessionRef),actorRole:'student',actorRef:'student',...parse(teacherCommentReply,q.body)})})));
 app.get('/api/v1/attempts/:attemptRef',asyncRoute(async(q,r)=>{const attempt=await service.getAttempt(parse(uuid,q.params.attemptRef));const tag=`"attempt-${attempt.version}"`;if(q.get('if-none-match')===tag)return r.status(304).end();r.set('ETag',tag);return r.json({ok:true,attempt});}));
 app.post('/api/v1/attempts/:attemptRef/retry',writes,asyncRoute(async(q,r)=>r.status(202).json({ok:true,attempt:await service.retryAttempt(parse(uuid,q.params.attemptRef))})));
 const internal=(q,r,next)=>sameSecret((q.get('authorization')||'').replace(/^Bearer\s+/i,''),config.internalApiToken)?next():r.status(401).json({ok:false,error:'UNAUTHORIZED'});
 app.post('/api/v1/internal/writing-flow/intake',internal,writingFlowReady,asyncRoute(async(q,r)=>{
   const receipt=await writingFlowService.intakePairs(parse(writingPairIntake,q.body));
   r.status(202).json({ok:true,receipt});
 }));
 app.post('/api/v1/internal/writing-flow/source-issues',internal,writingFlowReady,asyncRoute(async(q,r)=>{
   r.status(202).json({ok:true,issue:await writingFlowService.recordSourceIssue(
     parse(writingSourceIssue,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/sources/due',internal,writingFlowReady,asyncRoute(async(q,r)=>{
   const input=parse(z.object({sourceTypes:z.array(writingSourceType).min(1).max(4)
     .default(['manual','google_classroom','term_test']),limit:z.number().int().min(1).max(100).default(50)}),q.body);
   r.json({ok:true,sources:await writingFlowService.claimDueSources(input)});
 }));
 app.post('/api/v1/internal/writing-flow/sources/acknowledge',internal,writingFlowReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,source:await writingFlowService.acknowledgeSource(parse(writingSourceAck,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/classes/upsert',internal,writingFlowReady,asyncRoute(async(q,r)=>{
   const input=parse(z.object({classes:z.array(writingClassRegistryItem).min(1).max(200)}),q.body);
   r.json({ok:true,classes:await writingFlowService.upsertClassRegistry(input)});
 }));
 app.post('/api/v1/internal/writing-flow/classes/sync-from-mapping',internal,writingFlowReady,
   asyncRoute(async(_q,r)=>{
     r.json({ok:true,result:await writingFlowService.syncClassesFromMapping()});
   }));
 app.post('/api/v1/internal/writing-flow/classes/due',internal,writingFlowReady,asyncRoute(async(q,r)=>{
   const input=parse(z.object({limit:z.number().int().min(1).max(100).default(20)}),q.body);
   r.json({ok:true,classes:await writingFlowService.claimDueClasses(input)});
 }));
 app.post('/api/v1/internal/writing-flow/classes/acknowledge',internal,writingFlowReady,asyncRoute(async(q,r)=>{
   const input=parse(z.object({classCode:z.string().trim().min(1).max(80),
     outcome:z.enum(['succeeded','failed']),errorCode:z.string().trim().max(100).nullable().default(null)}),q.body);
   r.json({ok:true,class:await writingFlowService.acknowledgeClassScan(input)});
 }));
 app.post('/api/v1/internal/writing-flow/classroom-sources/upsert',internal,writingFlowReady,asyncRoute(async(q,r)=>{
   const input=parse(z.object({sources:z.array(writingClassroomSource).min(1).max(500)}),q.body);
   r.json({ok:true,sources:await writingFlowService.upsertClassroomSources(input)});
 }));
 app.post('/api/v1/internal/writing-flow/legacy/import',internal,writingFlowReady,asyncRoute(async(q,r)=>{
   const input=parse(z.object({records:z.array(writingLegacyItem).min(1).max(200)}),q.body);
   r.json({ok:true,result:await writingFlowService.importLegacyRecords({...input,actorRef:'legacy_import'})});
 }));
 app.post('/api/v1/internal/writing-flow/workflow-failures',internal,writingFlowReady,asyncRoute(async(q,r)=>{
   r.status(202).json({ok:true,failure:await writingFlowService.recordWorkflowFailure(
     parse(writingWorkflowFailure,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/scans/cursor',internal,writingScanReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,cursor:await writingFlowScan.cursor(parse(writingScanCursor,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/scans/begin',internal,writingScanReady,asyncRoute(async(q,r)=>{
   r.status(201).json({ok:true,scan:await writingFlowScan.begin(parse(writingScanBegin,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/scans/acknowledge',internal,writingScanReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,item:await writingFlowScan.acknowledge(parse(writingScanAck,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/scans/prepare',internal,writingScanReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,item:await writingFlowScan.prepare(parse(writingScanPrepare,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/scans/finish',internal,writingScanReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,scan:await writingFlowScan.finish(parse(z.object({runId:uuid}),q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/scans/due',internal,writingScanReady,asyncRoute(async(q,r)=>{
   const {limit}=parse(z.object({limit:z.number().int().min(1).max(200).default(100)}),q.body);
   r.json({ok:true,items:await writingFlowScan.due({limit})});
 }));
 app.post('/api/v1/internal/writing-flow/scans/finish-ready',internal,writingScanReady,asyncRoute(async(q,r)=>{
   const {limit}=parse(z.object({limit:z.number().int().min(1).max(200).default(100)}),q.body);
   const result=await writingFlowScan.finishReady({limit});
   const partial=result.failureCount>0;
   r.status(partial?207:200).json({ok:!partial,outcome:partial?'partial':'success',...result});
 }));
 app.post('/api/v1/internal/writing-flow/scans/receipts',internal,writingScanReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,receipts:await writingFlowScan.receipts(parse(writingScanReceipts,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/scans/closure-eligibility',internal,writingScanReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,closure:await writingFlowScan.closureEligibility(parse(writingScanClosure,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/scans/closure-due',internal,writingScanReady,asyncRoute(async(q,r)=>{
   const {limit}=parse(z.object({limit:z.number().int().min(1).max(200).default(100)}),q.body);
   r.json({ok:true,records:await writingFlowScan.dueClosures({limit})});
 }));
 app.post('/api/v1/internal/writing-flow/scans/closure-complete',internal,writingScanReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,closure:await writingFlowScan.completeClosure(parse(writingScanClosureComplete,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/stages/claim',internal,writingStageReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,claim:await writingFlowStage.claim(parse(writingClaim,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/stages/complete',internal,writingStageReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,completion:await writingFlowStage.complete(parse(writingComplete,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/stages/fail',internal,writingStageReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,failure:await writingFlowStage.fail(parse(writingFail,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/trcc-repairs/seed',internal,writingTrccRepairReady,asyncRoute(async(q,r)=>{
   const input=parse(z.object({batchRequestId:uuid,
     pairIds:z.array(uuid).min(1).max(5000)}),q.body);
   r.status(202).json({ok:true,result:await writingFlowTrccRepair.seed(input)});
 }));
 app.post('/api/v1/internal/writing-flow/trcc-repairs/claim',internal,writingTrccRepairReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,claim:await writingFlowTrccRepair.claim(parse(writingTrccRepairClaim,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/trcc-repairs/complete',internal,writingTrccRepairReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,completion:await writingFlowTrccRepair.complete(
     parse(writingTrccRepairComplete,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/trcc-repairs/fail',internal,writingTrccRepairReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,failure:await writingFlowTrccRepair.fail(parse(writingTrccRepairFail,q.body))});
 }));
 app.get('/api/v1/internal/writing-flow/trcc-repairs/summary',internal,writingTrccRepairReady,asyncRoute(async(_q,r)=>{
   r.json({ok:true,summary:await writingFlowTrccRepair.summary()});
 }));
 app.post('/api/v1/internal/writing-flow/ai-calls/start',internal,writingAiReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,call:await writingFlowAiCall.start(parse(writingAiStart,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/ai-calls/finish',internal,writingAiReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,call:await writingFlowAiCall.finish(parse(writingAiFinish,q.body))});
 }));
 app.post('/api/v1/internal/writing-flow/handoffs/due',internal,writingHandoffReady,asyncRoute(async(q,r)=>{
   const limit=parse(z.object({limit:z.number().int().min(1).max(100).default(20)}),q.body).limit;
   r.json({ok:true,handoffs:await writingFlowHandoff.due(limit)});
 }));
 app.post('/api/v1/internal/writing-flow/handoffs/recover',internal,writingHandoffReady,asyncRoute(async(q,r)=>{
   const limit=parse(z.object({limit:z.number().int().min(1).max(100).default(20)}),q.body).limit;
   const stages=await writingFlowHandoff.recoverExpired(limit);
   const trcc=writingFlowTrccRepair?await writingFlowTrccRepair.recoverExpired(limit):[];
   r.json({ok:true,recovered:[...stages,...trcc]});
 }));
 app.post('/api/v1/internal/grading-jobs/claim',internal,asyncRoute(async(q,r)=>r.json({ok:true,jobs:await service.claimJobs(parse(claim,q.body))})));
 app.post('/api/v1/internal/grading-jobs/:jobRef/complete',internal,asyncRoute(async(q,r)=>r.json({ok:true,job:await service.completeJob({jobRef:parse(uuid,q.params.jobRef),...parse(complete,q.body)})})));
 app.post('/api/v1/internal/grading-jobs/:jobRef/fail',internal,asyncRoute(async(q,r)=>r.json({ok:true,job:await service.failJob({jobRef:parse(uuid,q.params.jobRef),...parse(fail,q.body)})})));
 app.post('/api/v1/internal/grading-jobs/recover',internal,asyncRoute(async(_q,r)=>r.json({ok:true,jobs:await service.recoverJobs()})));
 app.post('/api/v1/admin/sessions/:sessionRef/sections/:section/reopen',adminAuth,teacherManage,asyncRoute(async(q,r)=>r.json({ok:true,session:await service.reopenSection({sessionRef:parse(uuid,q.params.sessionRef),section:parse(section,q.params.section),actorRef:q.reviewer.email,...parse(reopen,q.body)})})));
 app.get('/api/v1/admin/me',adminAuth,asyncRoute(async(q,r)=>r.json({ok:true,reviewer:{role:q.reviewer.role,canManage:Boolean(q.reviewer.canManage)},classes:await classAccess.listClasses(q.reviewer)})));
 app.get('/api/v1/admin/live/activities/:slug',adminAuth,asyncRoute(async(q,r)=>{const slug=parse(activitySlug,q.params.slug);const classRef=q.query.classRef?parse(uuid,q.query.classRef):null;if(classRef)await classAccess.assertActivityClass(q.reviewer,{activitySlug:slug,classRef});const data=await lessonService.listLive({activitySlug:slug,classRef,...dashboardScope(q)});r.json({ok:true,...data,permissions:{canManage:Boolean(q.reviewer?.canManage)}});}));
 app.get('/api/v1/admin/activities/:slug/provisional-students',adminAuth,asyncRoute(async(q,r)=>{const slug=parse(activitySlug,q.params.slug);const classRef=q.query.classRef?parse(uuid,q.query.classRef):null;if(classRef)await classAccess.assertActivityClass(q.reviewer,{activitySlug:slug,classRef});r.json({ok:true,students:await provisionalService.listPending({activitySlug:slug,classRef,...dashboardScope(q)})});}));
 app.get('/api/v1/admin/official-students/search',adminAuth,teacherManage,asyncRoute(async(q,r)=>{
  const search=parse(studentSearch,q.query);
  r.json({ok:true,students:await provisionalService.searchOfficialStudents({query:search.q,excludeStudentRef:search.excludeStudentRef,limit:search.limit})});
 }));
 app.post('/api/v1/admin/provisional-students/:studentRef/reset-code',adminAuth,teacherManage,asyncRoute(async(q,r)=>r.json({ok:true,...await provisionalService.resetCode({studentRef:parse(uuid,q.params.studentRef),actorRef:q.reviewer.email})})));
 app.post('/api/v1/admin/provisional-students/:studentRef/reconcile',adminAuth,teacherManage,asyncRoute(async(q,r)=>r.json({ok:true,...await provisionalService.reconcile({studentRef:parse(uuid,q.params.studentRef),actorRef:q.reviewer.email,...parse(reconcile,q.body)})})));
 app.post('/api/v1/admin/provisional-students/:studentRef/delete',adminAuth,teacherManage,asyncRoute(async(q,r)=>r.json({ok:true,...await provisionalService.deleteStudent({studentRef:parse(uuid,q.params.studentRef),actorRef:q.reviewer.email})})));
 app.get('/api/v1/admin/activities/:slug/export.csv',adminAuth,asyncRoute(async(q,r)=>{const slug=parse(activitySlug,q.params.slug);const classRef=q.query.classRef?parse(uuid,q.query.classRef):null;if(classRef)await classAccess.assertActivityClass(q.reviewer,{activitySlug:slug,classRef});const data=await lessonService.listLive({activitySlug:slug,classRef,...dashboardScope(q)});const header=['Họ và tên','Lớp','Tiến trình (%)','Số ô đã làm','Số phần đã đạt','Số lần Check','Cần hỗ trợ','Học viên tạm','Trạng thái đối soát'];const lines=[header,...data.students.map(s=>[s.displayName,s.className,s.progressPercent,s.filledFields,s.passedSectionCount,s.checkCount,s.supportRequired?'Có':'Không',s.provisional?'Có':'Không',s.reconciliationStatus||'official'])].map(row=>row.map(csvCell).join(','));r.type('text/csv; charset=utf-8').set('Content-Disposition',`attachment; filename="${q.params.slug}-progress.csv"`).send(`\ufeff${lines.join('\r\n')}`);}));
 app.get('/api/v1/admin/live/sessions/:sessionRef',adminAuth,asyncRoute(async(q,r)=>{const ref=parse(uuid,q.params.sessionRef);await classAccess.assertSession(q.reviewer,ref);try{return r.json({ok:true,session:await lessonService.sessionDetails(ref)});}catch(error){if(error.code!=='SESSION_NOT_FOUND')throw error;return r.json({ok:true,session:await service.sessionDetails(ref)});}}));
 app.get('/api/v1/admin/live/lesson-sessions/:sessionRef',adminAuth,asyncRoute(async(q,r)=>{const ref=parse(uuid,q.params.sessionRef);await classAccess.assertSession(q.reviewer,ref);r.json({ok:true,session:await lessonService.sessionDetails(ref)});}));
 app.get('/api/v1/admin/live/sessions/:sessionRef/teacher-comments',adminAuth,asyncRoute(async(q,r)=>{const ref=parse(uuid,q.params.sessionRef);await classAccess.assertSession(q.reviewer,ref);const data=await commentsReady().list({sessionRef:ref});const tag=`"teacher-comments-${data.version}"`;if(q.get('if-none-match')===tag)return r.status(304).end();r.set('ETag',tag);return r.json({ok:true,threads:data.threads});}));
 app.post('/api/v1/admin/live/sessions/:sessionRef/teacher-comments',writes,adminAuth,asyncRoute(async(q,r)=>{const ref=parse(uuid,q.params.sessionRef);await classAccess.assertSession(q.reviewer,ref);r.status(201).json({ok:true,thread:await commentsReady().create({sessionRef:ref,actorRef:q.reviewer.email,...parse(teacherCommentCreate,q.body)})});}));
 app.post('/api/v1/admin/teacher-comments/:threadRef/replies',writes,adminAuth,asyncRoute(async(q,r)=>{const ref=parse(uuid,q.params.threadRef);await classAccess.assertCommentThread(q.reviewer,ref);r.status(201).json({ok:true,thread:await commentsReady().reply({threadRef:ref,actorRole:'teacher',actorRef:q.reviewer.email,...parse(teacherCommentReply,q.body)})});}));
 app.post('/api/v1/admin/teacher-comments/:threadRef/status',writes,adminAuth,asyncRoute(async(q,r)=>{const ref=parse(uuid,q.params.threadRef);await classAccess.assertCommentThread(q.reviewer,ref);r.json({ok:true,thread:await commentsReady().setStatus({threadRef:ref,actorRef:q.reviewer.email,...parse(teacherCommentStatus,q.body)})});}));
 // Quản trị viên xem trạng thái từng cặp; API không trả bài làm hoặc kết quả chi tiết.
  app.get('/api/v1/admin/writing-flow/summary',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(_q,r)=>{
    r.json({ok:true,summary:await writingFlowService.summary()});
  }));
  app.get('/api/v1/admin/writing-flow/counts',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
    const classCode=q.query.classCode?parse(z.string().trim().min(1).max(80),q.query.classCode):null;
    const teacherName=q.query.teacherName?parse(z.string().trim().min(1).max(120),q.query.teacherName):null;
    const sourceKind=q.query.sourceKind?parse(z.enum(['homework','test']),q.query.sourceKind):null;
    r.json({ok:true,counts:await writingFlowService.dashboardCounts({classCode,teacherName,sourceKind})});
  }));
  app.get('/api/v1/admin/writing-flow/class-coverage',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(_q,r)=>{
    r.json({ok:true,classes:await writingFlowService.listClassCoverage()});
  }));
  app.get('/api/v1/admin/writing-flow/classes',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
    const view=parse(z.enum(['active','completed','review','all']),q.query.view??'active');
    r.json({ok:true,classes:await writingFlowService.listClasses({view})});
  }));
  app.get('/api/v1/admin/writing-flow/filter-options',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(_q,r)=>{
    r.json({ok:true,filters:await writingFlowService.filterOptions()});
  }));
  app.get('/api/v1/admin/writing-flow/daily-stats',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
    const classCode=q.query.classCode?parse(z.string().trim().min(1).max(80),q.query.classCode):null;
    const teacherName=q.query.teacherName?parse(z.string().trim().min(1).max(120),q.query.teacherName):null;
    const taskType=q.query.taskType?parse(z.enum(['task_1','task_2']),q.query.taskType):null;
    const dateFrom=q.query.dateFrom?parse(z.string().date(),q.query.dateFrom):null;
    const dateTo=q.query.dateTo?parse(z.string().date(),q.query.dateTo):null;
    const sourceKind=q.query.sourceKind?parse(z.enum(['homework','test']),q.query.sourceKind):null;
    r.json({ok:true,days:await writingFlowService.dailyStats({classCode,teacherName,taskType,dateFrom,dateTo,sourceKind})});
  }));
 app.get('/api/v1/admin/writing-flow/pairs',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
   const limit=parse(z.coerce.number().int().min(1).max(100),q.query.limit??50);
   const offset=parse(z.coerce.number().int().min(0).max(100000),q.query.offset??0);
   const classCode=q.query.classCode?parse(z.string().trim().min(1).max(80),q.query.classCode):null;
   const teacherName=q.query.teacherName
     ?parse(z.string().trim().min(1).max(120),q.query.teacherName):null;
   const stageKey=q.query.stageKey?parse(writingStage,q.query.stageKey):null;
   const stageStatus=q.query.stageStatus?parse(z.enum(['pending','running','needs_review','succeeded','skipped']),q.query.stageStatus):null;
   const view=q.query.view?parse(z.enum(['unfinished','delivered','skipped','review']),q.query.view):null;
   const includeCompleted=q.query.includeCompleted==='true';
   const taskType=q.query.taskType?parse(z.enum(['task_1','task_2']),q.query.taskType):null;
   const search=q.query.search?parse(z.string().trim().min(1).max(500),q.query.search):null;
   const searchScope=parse(z.enum(['all','identity','docs','content']),q.query.searchScope??'all');
   const dateFrom=q.query.dateFrom?parse(z.string().date(),q.query.dateFrom):null;
   const dateTo=q.query.dateTo?parse(z.string().date(),q.query.dateTo):null;
   const cursorAt=q.query.cursorAt?parse(z.string().datetime({offset:true}),q.query.cursorAt):null;
   const cursorId=q.query.cursorId?parse(uuid,q.query.cursorId):null;
   const sort=q.query.sort?parse(z.string().trim().min(1).max(300),q.query.sort):null;
   const sourceKind=q.query.sourceKind?parse(z.enum(['homework','test']),q.query.sourceKind):null;
   if(Boolean(cursorAt)!==Boolean(cursorId))throw new ApiError(400,'CURSOR_INCOMPLETE','Thiếu một phần con trỏ trang.');
   if(sort&&(cursorAt||cursorId))throw new ApiError(400,'WRITING_SORT_CURSOR_UNSUPPORTED','Danh sách đã sắp xếp dùng số trang.');
   const pairs=await writingFlowService.listPairs({classCode,teacherName,stageKey,stageStatus,
     view,includeCompleted,taskType,search,searchScope,dateFrom,dateTo,limit,offset,cursorAt,cursorId,sort,sourceKind});
   const last=pairs.at(-1);
   r.json({ok:true,pairs,nextCursor:!sort&&last&&pairs.length===limit
     ?{cursorAt:last.updated_at,cursorId:last.pair_id}:null,
     nextOffset:sort&&pairs.length===limit?offset+limit:null});
 }));
 app.get('/api/v1/admin/writing-flow/pairs/:pairId/detail',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
   r.json({ok:true,detail:await writingFlowService.pairDetail({pairId:parse(uuid,q.params.pairId)})});
 }));
 app.get('/api/v1/admin/writing-flow/pairs/:pairId/history',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
   const pairId=parse(uuid,q.params.pairId);
   r.json({ok:true,history:await writingFlowService.pairHistory({pairId})});
 }));
  app.get('/api/v1/admin/writing-flow/reviews',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
    const limit=parse(z.coerce.number().int().min(1).max(200),q.query.limit??100);
    const offset=parse(z.coerce.number().int().min(0).max(100000),q.query.offset??0);
    const classCode=q.query.classCode?parse(z.string().trim().min(1).max(80),q.query.classCode):null;
    const teacherName=q.query.teacherName?parse(z.string().trim().min(1).max(120),q.query.teacherName):null;
    const stageKey=q.query.stageKey?parse(writingStage,q.query.stageKey):null;
    const search=q.query.search?parse(z.string().trim().min(1).max(500),q.query.search):null;
    r.json({ok:true,reviews:await writingFlowService.listReviews({classCode,teacherName,
      stageKey,search,limit,offset})});
  }));
  app.get('/api/v1/admin/writing-flow/source-issues',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
    const limit=parse(z.coerce.number().int().min(1).max(200),q.query.limit??100);
    const offset=parse(z.coerce.number().int().min(0).max(100000),q.query.offset??0);
    const classCode=q.query.classCode?parse(z.string().trim().min(1).max(80),q.query.classCode):null;
    const teacherName=q.query.teacherName?parse(z.string().trim().min(1).max(120),q.query.teacherName):null;
    const search=q.query.search?parse(z.string().trim().min(1).max(500),q.query.search):null;
    const reasonCode=q.query.reasonCode?parse(z.string().trim().min(1).max(100),q.query.reasonCode):null;
    const status=parse(z.enum(['open','skipped']),q.query.status??'open');
    r.json({ok:true,issues:await writingFlowService.listSourceIssues({classCode,teacherName,
      search,reasonCode,status,limit,offset})});
  }));
 app.get('/api/v1/admin/writing-flow/sources',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
   const limit=parse(z.coerce.number().int().min(1).max(100),q.query.limit??50);
   const sourceType=q.query.sourceType?parse(z.enum(['lark_homework','google_classroom','manual','legacy','term_test']),q.query.sourceType):null;
   const status=q.query.status?parse(z.enum(['idle','pending','sent','acknowledged','needs_review','excluded']),q.query.status):null;
   const cursorAt=q.query.cursorAt?parse(z.string().datetime({offset:true}),q.query.cursorAt):null;
   const cursorId=q.query.cursorId?parse(uuid,q.query.cursorId):null;
   if(Boolean(cursorAt)!==Boolean(cursorId))throw new ApiError(400,'CURSOR_INCOMPLETE','Thiếu một phần con trỏ trang.');
   const sources=await writingFlowService.listSources({sourceType,status,limit,cursorAt,cursorId});
   const last=sources.at(-1);
   r.json({ok:true,sources,nextCursor:last&&sources.length===limit
     ?{cursorAt:last.updated_at,cursorId:last.source_id}:null});
 }));
 app.post('/api/v1/admin/writing-flow/manual-sources',writes,adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
   const source=await writingFlowService.addManualSource({...parse(writingManualSource,q.body),
     actorRef:q.reviewer.email});
   r.status(202).json({ok:true,source});
 }));
 app.post('/api/v1/admin/writing-flow/classes/:classCode/scan',writes,adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
   const result=await writingFlowService.requestClassScan({
     classCode:parse(z.string().trim().min(1).max(80),q.params.classCode),
     ...parse(writingOperatorAction,q.body),actorRef:q.reviewer.email});
   r.status(202).json({ok:true,result});
 }));
 app.get('/api/v1/admin/writing-flow/legacy',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
   const classCode=q.query.classCode?parse(z.string().trim().min(1).max(80),q.query.classCode):null;
   const limit=parse(z.coerce.number().int().min(1).max(100),q.query.limit??50);
   const offset=parse(z.coerce.number().int().min(0).max(100000),q.query.offset??0);
   r.json({ok:true,records:await writingFlowService.listLegacyRecords({classCode,limit,offset})});
 }));
 app.post('/api/v1/admin/writing-flow/pairs/:pairId/skip',writes,adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
   const result=await writingFlowService.skipPair({pairId:parse(uuid,q.params.pairId),
     ...parse(writingOperatorAction,q.body),actorRef:q.reviewer.email});
   r.status(202).json({ok:true,result});
 }));
 app.post('/api/v1/admin/writing-flow/pairs/:pairId/restore',writes,adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
   const result=await writingFlowService.restorePair({pairId:parse(uuid,q.params.pairId),
     ...parse(writingOperatorAction,q.body),actorRef:q.reviewer.email});
   r.status(202).json({ok:true,result});
 }));
 app.post('/api/v1/admin/writing-flow/pairs/:pairId/retry',writes,adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
   const result=await writingFlowService.requestStageRetry({pairId:parse(uuid,q.params.pairId),
     ...parse(writingStageRetry,q.body),actorRef:q.reviewer.email});
   r.status(202).json({ok:true,result});
 }));
 app.post('/api/v1/admin/writing-flow/source-issues/:issueKey/retry',writes,adminAuth,
   writingFlowAdmin,writingScanReady,asyncRoute(async(q,r)=>{
     const issueKey=parse(z.string().regex(/^[0-9a-f]{64}$/),q.params.issueKey);
     const {requestId}=parse(z.object({requestId:uuid}),q.body);
     const scan=await writingFlowScan.retrySourceIssue({issueKey,requestId});
     r.status(202).json({ok:true,scan});
   }));
 app.post('/api/v1/admin/writing-flow/source-issues/:issueKey/skip',writes,adminAuth,
   writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
     const result=await writingFlowService.skipSourceIssue({
       issueKey:parse(z.string().regex(/^[0-9a-f]{64}$/),q.params.issueKey),
       ...parse(writingOperatorAction,q.body),actorRef:q.reviewer.email});
     r.status(202).json({ok:true,result});
   }));
 app.post('/api/v1/admin/writing-flow/source-issues/:issueKey/restore',writes,adminAuth,
   writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
     const result=await writingFlowService.restoreSourceIssue({
       issueKey:parse(z.string().regex(/^[0-9a-f]{64}$/),q.params.issueKey),
       ...parse(writingOperatorAction,q.body),actorRef:q.reviewer.email});
     r.status(202).json({ok:true,result});
   }));
 app.get('/api/v1/admin/writing-flow/workflow-failures',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
   const limit=parse(z.coerce.number().int().min(1).max(200),q.query.limit??100);
   const offset=parse(z.coerce.number().int().min(0).max(100000),q.query.offset??0);
   r.json({ok:true,failures:await writingFlowService.listWorkflowFailures({limit,offset})});
 }));
 app.get('/api/v1/admin/writing-flow/operator-events',adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
   const limit=parse(z.coerce.number().int().min(1).max(200),q.query.limit??100);
   const offset=parse(z.coerce.number().int().min(0).max(100000),q.query.offset??0);
   const classCode=q.query.classCode?parse(z.string().trim().min(1).max(80),q.query.classCode):null;
   const eventType=q.query.eventType?parse(z.string().trim().min(1).max(80),q.query.eventType):null;
   r.json({ok:true,events:await writingFlowService.listOperatorEvents({classCode,eventType,limit,offset})});
 }));
 // Bấm chạy lại chỉ ghi yêu cầu bền; workflow retry phải nhận và xác nhận sau đó.
 app.post('/api/v1/admin/writing-flow/reviews/:reviewId/retry',writes,adminAuth,writingFlowAdmin,writingFlowReady,asyncRoute(async(q,r)=>{
   const reviewId=parse(uuid,q.params.reviewId);
   const {requestId}=parse(z.object({requestId:uuid}),q.body);
   const review=await writingFlowService.requestRetry({reviewId,requestId,actorRef:q.reviewer.email});
   r.status(202).json({ok:true,review});
 }));
 app.post('/api/v1/admin/attempts/:attemptRef/retry',writes,adminAuth,teacherManage,asyncRoute(async(q,r)=>r.status(202).json({ok:true,attempt:await lessonService.retryFailedAttempt({attemptRef:parse(uuid,q.params.attemptRef),actorRef:q.reviewer.email})})));
 app.post('/api/v1/admin/lesson-sessions/:sessionRef/sections/:section/reopen',adminAuth,teacherManage,asyncRoute(async(q,r)=>r.json({ok:true,session:await lessonService.reopenSection({sessionRef:parse(uuid,q.params.sessionRef),section:parse(lessonSection,q.params.section),actorRef:q.reviewer.email,...parse(reopen,q.body)})})));
 app.use((_q,r)=>r.status(404).json({ok:false,error:'NOT_FOUND'}));
 app.use((error,q,r,_n)=>{
   const writingRoute=q.path.startsWith('/api/v1/internal/writing-flow')
     || q.path.startsWith('/api/v1/admin/writing-flow');
   const parseFailure=writingRoute && error?.type==='entity.parse.failed';
   const oversizedBody=writingRoute && error?.type==='entity.too.large';
   // Nhận vào: lỗi đọc JSON hoặc lỗi nghiệp vụ trước khi API gửi phản hồi.
   // Việc chính: phân loại lỗi đầu vào, giữ đúng mã truy vết của yêu cầu Writing.
   // Kết quả: 400/413 cho dữ liệu sai; lỗi máy chủ thật mới trả 500.
   // Khi lỗi: log vẫn giữ mã và loại lỗi, không ghi nội dung bài gửi tới API.
   r.locals.writingErrorCode=parseFailure?'INVALID_JSON':oversizedBody?'BODY_TOO_LARGE'
     :error instanceof ApiError?error.code:'INTERNAL_ERROR';
   if(parseFailure||oversizedBody)return r.status(parseFailure?400:413).json({ok:false,
     error:r.locals.writingErrorCode,requestId:r.locals.writingRequestId});
   if(error instanceof ApiError)return r.status(error.status).json({ok:false,error:error.code,
     message:error.message,...(error.current?{current:error.current}:{})});
   const requestId=r.locals.writingRequestId||crypto.randomUUID();
   console.error(`Writing Task 1 API error request_id=${requestId} type=${error?.name||'Error'} code=${error?.code||'none'}`);
   return r.status(500).json({ok:false,error:'INTERNAL_ERROR',requestId});
 });
 return app;
}
