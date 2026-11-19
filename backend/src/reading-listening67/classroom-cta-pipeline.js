import { createHash, randomUUID } from 'node:crypto';
import { classroomSourceKey } from './classroom-cta-discovery.js';

const products = [
  'reading_practice', 'speaking', 'listening_homework',
  'reading_homework', 'legacy', 'listening_practice',
];
const terminal = new Set(['verified', 'not_applicable']);
const identityFields = ['courseId', 'courseworkId', 'submissionId'];
const errorCode = (error, fallback) => /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : fallback;
const identity = source => ({
  documentId: source.documentId,
  ...Object.fromEntries(identityFields.map(field => [field, source.classroom[field]])),
});
const keyOfIdentity = row => classroomSourceKey({ documentId: row.documentId, classroom: row });

function requireCta(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function indexSources(sources, scope) {
  const expected = new Map();
  const documents = new Set();
  for (const source of sources) {
    requireCta(source?.classroom?.courseId === scope.courseId
      && source.classroom.classCode === scope.classCode
      && (!scope.courseWorkId || source.classroom.courseworkId === scope.courseWorkId),
    'CTA_SOURCE_SCOPE_MISMATCH');
    requireCta(!documents.has(source.documentId), 'CTA_DOCUMENT_SOURCE_CONFLICT');
    documents.add(source.documentId);
    expected.set(classroomSourceKey(source), source);
  }
  return expected;
}

// Keep scheduler ownership, transport delivery and a durable worker receipt distinct.
export function createClassroomCtaProducer({ store, discover, publish, ownsScope, recordOtherSources, log = () => {} }) {
  const assertOwnership = async scope => requireCta(await ownsScope(scope) === true, 'CTA_SCOPE_NOT_OWNED');
  return async scope => {
    await assertOwnership(scope);
    const runId = 'cta-run-' + randomUUID();
    const lease = await store.scanStart({ executionId: runId });
    if (!lease.acquired) return { status: 'busy', discovered: 0, published: 0 };
    const run = { executionId: runId, leaseToken: lease.leaseToken };
    let failureCode;
    let discovered = 0;
    let published = 0;
    const started = performance.now();
    try {
      const scan = await discover(scope);
      requireCta(scan.courseId === scope.courseId, 'CTA_SCAN_SCOPE_MISMATCH');
      const candidates = scope.documentId ? scan.sources.filter(source => source.documentId === scope.documentId) : scan.sources;
      const sources = indexSources(candidates, scope);
      if (scope.documentId) requireCta(sources.size === 1, 'CTA_MANUAL_DOCUMENT_NOT_FOUND');
      discovered = sources.size;
      for (let offset = 0; offset < candidates.length; offset += 20) {
        await assertOwnership(scope);
        const batch = candidates.slice(offset, offset + 20);
        const { sources: replies } = await store.sourceBatch({ sources: batch });
        requireCta(Array.isArray(replies) && replies.length === batch.length, 'CTA_SOURCE_ACK_INVALID');
        const batchKeys = new Set(batch.map(classroomSourceKey));
        const jobs = [];
        for (const reply of replies) {
          const key = keyOfIdentity(reply);
          requireCta(batchKeys.delete(key) && reply.saved === true
            && typeof reply.ctaNeeded === 'boolean'
            && (!reply.ctaNeeded || typeof reply.dispatchToken === 'string' && reply.dispatchToken),
          'CTA_SOURCE_ACK_INVALID');
          if (reply.ctaNeeded) {
            jobs.push({ runId, source: sources.get(key), dispatchToken: reply.dispatchToken, epoch: scope.epoch });
          }
        }
        for (const job of jobs) {
          const ack = await publish(job);
          requireCta(ack?.confirmed === true && ack.dispatchToken === job.dispatchToken, 'CTA_PUBLISH_UNCONFIRMED');
          const item = { ...identity(job.source), dispatchToken: job.dispatchToken };
          const saved = await store.sourceCtaEnqueuedBatch({ sources: [item] });
          const receipt = saved?.sources?.[0];
          requireCta(saved?.sources?.length === 1 && receipt?.saved === true
            && receipt.dispatchToken === item.dispatchToken && keyOfIdentity(receipt) === keyOfIdentity(item),
          'CTA_PUBLISH_ACK_NOT_SAVED');
          published++;
        }
      }
      await recordOtherSources?.(scope, candidates, runId);
      return { status: 'done', runId, discovered, published, counts: scan.counts, speaking: scan.speaking };
    } catch (error) {
      failureCode = errorCode(error, 'CTA_SCAN_FAILED');
      throw error;
    } finally {
      try {
        await store.scanCourseResult({ ...run, courseId: scope.courseId,
          status: failureCode ? 'failed' : 'done', ...(failureCode ? { errorCode: failureCode } : {}) });
      } finally {
        try {
          await store.scanFinish(run);
        } finally {
          log({ stage: 'scan', runId, classCode: scope.classCode, discovered, published,
            durationMs: Math.round(performance.now() - started), errorCode: failureCode });
        }
      }
    }
  };
}

// Transport ACK is left to the caller, after the returned state has been recorded.
export function createClassroomCtaProcessor({ store, adapters, verifyProof, ownsScope, lockDocument,
  ownsJob = async () => true, canReuseProof = () => true, prepare, log = () => {} }) {
  requireCta(products.every(product => typeof adapters?.[product] === 'function')
    && typeof verifyProof === 'function' && typeof ownsScope === 'function' && typeof lockDocument === 'function',
  'CTA_PROCESSOR_CONFIGURATION_INVALID');
  return async job => {
    const { source, dispatchToken, epoch, runId } = job;
    const item = identity(source);
    const executionId = job.executionId || 'cta-job-' + randomUUID();
    requireCta(/^cta-job-[a-f0-9-]{36}$/.test(executionId), 'CTA_EXECUTION_ID_INVALID');
    const sourceTag = createHash('sha256').update(keyOfIdentity(item)).digest('hex').slice(0, 20);
    const claim = { ...item, dispatchToken, executionId };
    const assertOwnership = async () => {
      requireCta(await ownsScope({ ...source.classroom, epoch }) === true, 'CTA_SCOPE_NOT_OWNED');
      requireCta(await ownsJob(job) === true, 'CTA_JOB_LEASE_NOT_OWNED');
    };
    const context = { source, runId, executionId, dispatchToken, assertOwnership, nativeReceipts: new Map() };
    await context.assertOwnership();
    return lockDocument(item.documentId, async () => {
      await context.assertOwnership();
      const acquired = await store.sourceCtaState(claim, { resumeProof: true, source });
      if (!acquired.shouldProcess) {
        log({ stage: 'claim', runId, executionId, sourceTag, outcome: 'skipped' });
        return { state: 'skipped' };
      }
      const proof = [];
      let failure;
      let needsReview;
      try {
        const prepared = await prepare?.(context);
        if (prepared) {
          context.initialDocument = prepared.initialDocument;
          context.speakingSnapshot = prepared.speakingSnapshot;
        }
      } catch (error) {
        failure = errorCode(error, 'CTA_COPY_PROOF_FAILED');
        log({ stage: 'copy_proof', runId, executionId, sourceTag, outcome: 'error', errorCode: failure });
      }
      for (const product of failure ? [] : products) {
        const started = performance.now();
        await context.assertOwnership();
        const previous = canReuseProof(product)
          ? acquired.previousProof?.find(p => p.product === product && p.documentId === item.documentId && terminal.has(p.status))
          : undefined;
        try {
          const result = previous ?? await adapters[product](context);
          if (product === 'legacy' && result?.documentId === item.documentId && result.status === 'review'
            && /^[A-Z0-9_|-]{1,200}$/.test(result.errorCode || '')) {
            needsReview = result.errorCode;
            log({ stage: 'product', runId, executionId, sourceTag, product, outcome: 'review', errorCode: needsReview });
            continue;
          }
          requireCta(result?.documentId === item.documentId && terminal.has(result.status), 'CTA_PRODUCT_ACK_INVALID');
          proof.push({ product, documentId: item.documentId, status: result.status });
          log({ stage: 'product', runId, executionId, sourceTag, product,
            outcome: result.status, resumed: Boolean(previous), durationMs: Math.round(performance.now() - started) });
        } catch (error) {
          const code = errorCode(error, 'CTA_PRODUCT_FAILED');
          failure ??= code;
          log({ stage: 'product', runId, executionId, sourceTag, product,
            outcome: 'error', errorCode: code, durationMs: Math.round(performance.now() - started) });
          break;
        }
      }
      if (!failure && !needsReview) {
        try {
          const invalid = await verifyProof(context, proof);
          requireCta(Array.isArray(invalid) && invalid.every(product => products.includes(product)),
            'CTA_FINAL_READBACK_INVALID');
          if (invalid.length) {
            failure = 'CTA_FINAL_READBACK_FAILED';
            for (let index = proof.length - 1; index >= 0; index--) {
              if (invalid.includes(proof[index].product)) proof.splice(index, 1);
            }
          }
        } catch (error) {
          failure = errorCode(error, 'CTA_FINAL_READBACK_UNAVAILABLE');
        }
      }
      await context.assertOwnership();
      const state = failure ? 'error' : needsReview ? 'review' : 'ready';
      const reason = failure ?? needsReview;
      const result = await store.sourceCtaResult({ ...claim, proof, state, errorCode: reason });
      requireCta(result?.saved === true && result.documentId === item.documentId && result.changed === 1
        && (failure ? ['error', 'review'].includes(result.state) : result.state === state), 'CTA_FINISH_ACK_INVALID');
      log({ stage: 'finish', runId, executionId, sourceTag, outcome: result.state, errorCode: reason });
      return { state: result.state, proof, errorCode: reason };
    });
  };
}

// A session-level advisory lock can span network calls without an open transaction.
export function createClassroomCtaDocumentLock({ pool }) {
  return async (documentId, execute) => {
    const client = await pool.connect();
    const key = 'rl67:cta-writer:' + documentId;
    let locked = false;
    let releaseError;
    try {
      const { rows } = await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS locked', [key]);
      locked = rows[0]?.locked === true;
      requireCta(locked, 'CTA_DOCUMENT_BUSY');
      return await execute();
    } finally {
      if (locked) {
        try {
          const { rows } = await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0)) AS released', [key]);
          requireCta(rows[0]?.released === true, 'CTA_DOCUMENT_LOCK_NOT_RELEASED');
        } catch (error) {
          releaseError = error;
        }
      }
      client.release(releaseError);
      if (releaseError) throw releaseError;
    }
  };
}
