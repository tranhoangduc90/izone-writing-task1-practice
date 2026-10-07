/**
 * Nhận request n8n qua token riêng, kiểm identity và gọi kho dữ liệu riêng.
 * Chỉ gắn tuyến /api/v1/internal/reading-listening67; lỗi không rơi vào Writing.
 * Không có tuyến công khai chứa danh tính học viên hoặc cấu hình chấm.
 */
import { timingSafeEqual } from 'node:crypto';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ReadingListening67Error } from './store.js';
const key = z.string().regex(/^[A-Za-z0-9_-]{1,80}$/);
const identity = {
  documentId: z.string().regex(/^[A-Za-z0-9_-]{20,200}$/),
  assignmentCode: z.string().regex(/^67-(reading-0[1-6]|listening-0[1-5])$/),
  tabId: z.string().regex(/^[A-Za-z0-9_.-]{1,100}$/).optional(),
};
const owner = { jobId: key, leaseToken: z.uuid() };
const text = z.string().trim().min(1).max(200);
const classroom = z.object({courseId:text,courseworkId:text,submissionId:text,studentId:text.optional(),classCode:text.optional(),sourceEventId:text}).strict();
const sourceInput=z.object({documentId:identity.documentId,classroom:classroom.extend({homeworkTitle:z.string().trim().max(300).optional(),classroomName:text.optional()})}).strict();
const schemas = {
  register: z.object({ ...identity, classroom: z.object({ courseId: text, courseworkId: text, submissionId: text, studentId: text.optional(), classCode: text.optional(), sourceEventId: text }).strict().optional() }).strict(),
  accept: z.object({ ...identity, requestId: key, jobId: key.optional() }).strict(),
  source:sourceInput,
  sourceBatch:z.object({sources:z.array(sourceInput).min(1).max(20)}).strict(),
  sourceCtaState:z.object({documentId:identity.documentId}).strict(),
  sourceCtaEnqueuedBatch:z.object({sources:z.array(z.object({documentId:identity.documentId,courseId:text,courseworkId:text,submissionId:text,dispatchToken:z.uuid()}).strict()).min(1).max(20)}).strict(),
  sourceCtaResult: z.object({documentId:identity.documentId,state:z.enum(['ready','review','error']),errorCode:z.string().regex(/^[A-Z0-9_|-]{1,200}$/).optional()}).strict(),
  scanStart:z.object({executionId:key}).strict(),
  scanFinish:z.object({executionId:key,leaseToken:z.uuid()}).strict(),
  scanCourseResult:z.object({executionId:key,leaseToken:z.uuid(),courseId:text,status:z.enum(['done','failed']),errorCode:z.string().regex(/^[A-Z0-9_]{1,100}$/).optional()}).strict(),
  claim: z.object({ jobId: key, executionId: key }).strict(),
  validate: z.object({ ...owner, ...identity, sourceRevision: text, templateVersion: text, graderVersion: text, answerSha256: z.string().regex(/^[a-f0-9]{64}$/), done: z.number().int().min(0), total: z.number().int().positive() }).strict(),
  renew: z.object({...owner,phase:z.literal('writing').optional()}).strict(),
  executionFailed: z.object({ executionId: key, errorCode: z.string().regex(/^[A-Z0-9_]{1,100}$/) }).strict(),
  resolveReview: z.object({ jobId: key, processorExecutionId: key,
    proof: z.object({ documentId: identity.documentId, assignmentCode: identity.assignmentCode,
      revisionId: text, warningExecutionId: key, verified: z.literal(true),
      processorStopped: z.literal(true), warningStopped: z.literal(true),
      noWarningWriteAttempted: z.literal(true), noGradingInvoked: z.literal(true),
      sourceError: z.enum(['RL67_WARNING_SOURCE_CHANGED','WARNING_ANCHOR_AMBIGUOUS']) }).strict() }).strict(),
  finish: z.object({ ...owner, status: z.enum(['done','incomplete','failed','needs_review']), warningState: z.enum(['unchecked','present_verified','absent_verified','write_failed']).optional(), errorCode: z.string().max(100).optional(), result: z.record(z.string(), z.unknown()).optional(), proof: z.object({ documentId: identity.documentId, assignmentCode: identity.assignmentCode, jobId: key, verified: z.literal(true), revisionId: text }).strict().optional() }).strict(),
};
export function mountReadingListening67(app, { store, token, unavailable = false }) {
  const router = express.Router();
  router.use((q, r, next) => {
    const actual = Buffer.from(String(q.headers.authorization || '').replace(/^Bearer /, ''));
    const expected = Buffer.from(token || '');
    if (expected.length < 32 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return r.status(401).json({ ok: false, error: 'RL67_UNAUTHORIZED' });
    if (unavailable || !store) return r.status(503).json({ ok: false, error: 'RL67_UNAVAILABLE' });
    next();
  });
  router.use(rateLimit({ windowMs: 60_000, limit: 1800, standardHeaders: 'draft-8', legacyHeaders: false, message: { ok: false, error: 'RL67_RATE_LIMITED' } }));
  router.use(express.json({ limit: '32kb', strict: true }));
  const route = work => (q,r,next) => Promise.resolve().then(() => work(q,r)).catch(next);
  for (const action of Object.keys(schemas)) router.post('/' + action, route(async(q,r) => {
    const parsed = schemas[action].safeParse(q.body);
    if (!parsed.success) return r.status(400).json({ ok: false, error: 'RL67_INVALID_INPUT' });
    r.status(action === 'accept' ? 202 : 200).json({ ok: true, ...await store[action](parsed.data) });
  }));
  router.get('/jobs/:jobId', route(async(q,r) => {
    const parsed = key.safeParse(q.params.jobId);
    if (!parsed.success) return r.status(400).json({ ok: false, error: 'RL67_INVALID_INPUT' });
    r.json({ ok: true, ...await store.status({ jobId: parsed.data }) });
  }));
  router.get('/ready', route(async(_q,r) => { await store.ready(); r.json({ ok: true, contract: 'reading-listening67-v1' }); }));
  router.get('/courses',route(async(_q,r)=>r.json({ok:true,...await store.courses()})));
  router.get('/catalog/:assignmentCode', route(async(q,r) => {
    const parsed = identity.assignmentCode.safeParse(q.params.assignmentCode);
    if (!parsed.success) return r.status(400).json({ ok: false, error: 'RL67_INVALID_INPUT' });
    r.json({ ok: true, ...await store.catalog({ assignmentCode: parsed.data }) });
  }));
  router.post('/recover', route(async(q,r) => {
    if (Object.keys(q.body || {}).length) return r.status(400).json({ ok: false, error: 'RL67_INVALID_INPUT' });
    r.json({ ok: true, ...await store.recoverExpired() });
  }));
  router.use((_q,r) => r.status(404).json({ ok: false, error: 'RL67_NOT_FOUND' }));
  router.use((error,_q,r,_next) => {
    const known = error instanceof ReadingListening67Error;
    const status = known ? error.status : error?.type === 'entity.parse.failed' ? 400 : error?.type === 'entity.too.large' ? 413 : 503;
    r.status(status).json({ ok: false, error: known ? error.code : status === 400 ? 'RL67_INVALID_JSON' : status === 413 ? 'RL67_BODY_TOO_LARGE' : 'RL67_DATABASE_UNAVAILABLE' });
  });
  app.use('/api/v1/internal/reading-listening67', router);
}
