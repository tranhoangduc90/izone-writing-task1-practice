import { randomUUID } from 'node:crypto';
import { parseK67SpeakingScopes } from './classroom-cta-speaking.js';

const period = 15 * 60_000;
function requireRuntime(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}
const codeOf = (error, fallback) => /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : fallback;

export function createK67CtaRuntime({ nativeStore, listScope, resolveSpeakingCourse, readSpeakingScopes, produce,
  reconcileSpeaking, processJob, onWorkAvailable = () => {}, log = () => {}, clock = Date.now }) {
  async function run({ request = {}, runId, trigger }) {
    const main = await listScope({ classCode: request.classCode });
    const scopes = parseK67SpeakingScopes(await readSpeakingScopes())
      .filter(s => !request.classCode || s.classCode === request.classCode
        && (!request.courseWorkId || s.courseWorkId === request.courseWorkId));
    const byCourse = new Map(main.courses.map(course => [course.courseId, { ...course, speaking: [] }]));
    const missing = [...main.missing];
    for (const scope of scopes) {
      let course = byCourse.get(scope.courseId);
      if (!course) {
        try {
          const verified = await resolveSpeakingCourse(scope);
          requireRuntime(verified?.courseId === scope.courseId && verified.classCode === scope.classCode
            && verified.classroomName, 'SPEAKING_CLASSROOM_APPROVAL_MISSING');
          course = { ...verified, shared: false, speaking: [] };
          byCourse.set(scope.courseId, course);
        } catch (error) {
          missing.push({ classCode: scope.classCode, reason: codeOf(error, 'SPEAKING_CLASSROOM_APPROVAL_MISSING') });
          continue;
        }
      }
      requireRuntime(course.classCode === scope.classCode, 'CTA_CLASSROOM_REGISTRY_CONFLICT');
      course.speaking.push(scope);
    }
    const results = [];
    for (const course of byCourse.values()) {
      const epoch = await nativeStore.ownership(course);
      if (epoch === null) {
        results.push({ classCode: course.classCode, status: 'legacy_owner' });
        continue;
      }
      const input = { ...course, epoch, parentRunId: runId, ...(request.courseWorkId ? { courseWorkId: request.courseWorkId } : {}) };
      try {
        const scan = await produce(input);
        if (scan.status !== 'done') {
          results.push({ classCode: course.classCode, status: scan.status });
          continue;
        }
        const speech = [];
        for (const snapshot of scan.speaking) {
          const registry = course.speaking.find(item => item.courseWorkId === snapshot.courseWorkId);
          requireRuntime(registry, 'SPEAKING_SNAPSHOT_IDENTITY_MISMATCH');
          const result = await reconcileSpeaking(registry, snapshot, epoch);
          speech.push(result.status);
        }
        results.push({ classCode: course.classCode, status: speech.includes('partial') ? 'partial' : 'done',
          scanId: scan.runId, discovered: scan.discovered, published: scan.published, counts: scan.counts });
      } catch (error) {
        results.push({ classCode: course.classCode, status: 'failure', errorCode: codeOf(error, 'CTA_CLASSROOM_SCAN_FAILED') });
      } finally {
        // The periodic Speaking reconciliation can hold the same document lock.
        onWorkAvailable();
      }
    }
    const status = missing.length || results.some(r => !['done', 'legacy_owner'].includes(r.status)) ? 'partial' : 'done';
    log({ stage: 'scheduler', runId, trigger, status, portalClasses: main.portalClasses, missing, results });
    return { runId, trigger, status, portalClasses: main.portalClasses, missing, results };
  }

  return {
    async tick() {
      const slot = new Date(Math.floor(clock() / period) * period);
      return nativeStore.withSlot(slot, async runId => run({ runId, trigger: 'schedule' }));
    },
    async manual(request) {
      requireRuntime(request && /^IC[0-9]+$/.test(request.classCode)
        && (!request.courseWorkId || /^[1-9][0-9]{0,19}$/.test(request.courseWorkId)), 'CTA_MANUAL_SCOPE_INVALID');
      return run({ request, runId: randomUUID(), trigger: 'manual' });
    },
    async workOnce() {
      const job = await nativeStore.claim();
      if (!job) return { status: 'idle' };
      try {
        const receipt = await processJob(job);
        await nativeStore.settle(job, receipt);
        return { status: receipt.state };
      } catch (error) {
        if (error?.code === 'CTA_DOCUMENT_BUSY') {
          await nativeStore.deferBusyDocument(job);
          log({ stage: 'worker_deferred', runId: job.runId, executionId: job.executionId,
            errorCode: 'CTA_DOCUMENT_BUSY' });
          return { status: 'busy' };
        }
        // A transport/Google result may be unknown. The same job can resume at its lease expiry.
        log({ stage: 'worker_recovery', runId: job.runId, executionId: job.executionId,
          status: 'unknown', errorCode: codeOf(error, 'CTA_WORKER_OUTCOME_UNKNOWN') });
        return { status: 'unknown' };
      }
    },
  };
}
