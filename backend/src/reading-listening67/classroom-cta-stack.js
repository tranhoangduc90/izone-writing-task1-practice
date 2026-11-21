import { createClassroomCtaDiscovery } from './classroom-cta-discovery.js';
import { createK67ClassroomScope } from './classroom-cta-scope.js';
import { createReadingListening67Store } from './store.js';
import { createClassroomCtaDocumentLock, createClassroomCtaProcessor, createClassroomCtaProducer, createK67NativeScanLock } from './classroom-cta-pipeline.js';
import { createK67NativeStore } from './classroom-cta-native-store.js';
import { createK67ProductAdapters, findK67ListeningHomeworkCode, findK67ReadingHomeworkCode, findK67SpeakingCode } from './classroom-cta-adapters.js';
import { createK67SpeakingCta } from './classroom-cta-speaking.js';
import { createK67LegacyCta } from './classroom-cta-legacy.js';
import { createK67CtaRuntime } from './classroom-cta-runtime.js';
import { createK67ManualDocuments } from './classroom-cta-manual.js';
import { createK67WritingSourceLane } from './classroom-cta-writing.js';

export function limitK67RegistrarCredentialRetries(register, onPaused, clock = Date.now) {
  let blockedUntil = 0;
  return async (...args) => {
    if (clock() < blockedUntil) {
      throw Object.assign(new Error('CTA_PRODUCT_CREDENTIAL_PAUSED'), { code: 'CTA_PRODUCT_CREDENTIAL_PAUSED' });
    }
    try {
      return await register(...args);
    } catch (error) {
      if (['WEB_UNAUTHORIZED', 'CTA_NATIVE_HTTP_401'].includes(error?.code)) {
        blockedUntil = clock() + 15 * 60_000;
        onPaused(error.code);
      }
      throw error;
    }
  };
}

function nativePracticeUrl(value, product, docId, code, classCode) {
  try {
    const url = new URL(value);
    const productPath = product === 'reading_practice' ? 'reading-practice' : 'listening-practice';
    return url.origin === 'https://tranhoangduc90.github.io'
      && url.pathname.startsWith('/izone-ai-team-pages/' + productPath + '/')
      && url.searchParams.get('documentId') === docId
      && (url.searchParams.get('assignmentCode') ?? url.searchParams.get('lesson')) === code
      && (!url.searchParams.has('class') || url.searchParams.get('class') === classCode)
      && (!url.searchParams.has('mode') || url.searchParams.get('mode') === 'student');
  } catch { return false; }
}

function comparablePracticeUrl(value) {
  try {
    const url = new URL(value);
    url.searchParams.delete('class');
    url.searchParams.delete('mode');
    return url.href;
  } catch { return null; }
}

export function verifyK67FinalProof(docs) {
  return async (context, proof) => {
    const docId = context.source.documentId;
    const current = await docs.read(docId);
    if (current?.documentId !== docId || !current.revisionId) throw Error('CTA_FINAL_DOC_INVALID');
    const urls = new Set();
    function collect(value) {
      if (!value || typeof value !== 'object') return;
      if (value.textRun?.textStyle?.link?.url) urls.add(value.textRun.textStyle.link.url);
      for (const [key, child] of Object.entries(value)) if (key !== 'textRun') collect(child);
    }
    collect(current.tabs || current.body);
    return proof.filter(row => {
      if (row.status === 'not_applicable') return false;
      const receipt = context.nativeReceipts.get(row.product);
      const expected = receipt?.entryUrls ?? (receipt?.entryUrl ? [receipt.entryUrl] : []);
      if (Array.isArray(expected) && expected.length && expected.every(url => urls.has(url))) return false;
      if (['reading_practice', 'listening_practice'].includes(row.product) && receipt?.code) {
        // The native Reading legacy receipt omits its stored URL. Listening may add class/mode to the reply.
        for (const url of urls) {
          if (nativePracticeUrl(url, row.product, docId, receipt.code, context.source.classroom.classCode)
            && (!receipt.entryUrl || comparablePracticeUrl(url) === comparablePracticeUrl(receipt.entryUrl))) return false;
        }
      }
      return true;
    }).map(row => row.product);
  };
}

export function createK67CtaStack({ pool, getPortal, getMappings, classroomGet, classroomFallbackGet, resolveSpeakingCourse,
  docs, verifyCopy, speakingApi, readingHomework, listeningHomework, readingPractice, listeningPractice,
  writingConfiguration, autoEnroll = false, onWorkAvailable = () => {}, log = () => {} }) {
  const store = createReadingListening67Store({ pool });
  const nativeStore = createK67NativeStore({ pool });
  const writing = writingConfiguration
    ? createK67WritingSourceLane({ ...writingConfiguration, pool, ownsScope: nativeStore.ownsScope, log })
    : null;
  const lockDocument = createClassroomCtaDocumentLock({ pool });
  const readPrimary = createClassroomCtaDiscovery({ get: classroomGet });
  const readFallback = classroomFallbackGet && createClassroomCtaDiscovery({ get: classroomFallbackGet });
  const canUseFallback = error => ['CTA_CLASSROOM_GET_403', 'CTA_CLASSROOM_GET_404'].includes(error?.code);
  async function discover(scope) {
    try {
      return await readPrimary(scope);
    } catch (error) {
      if (!readFallback || !canUseFallback(error)) throw error;
      log({ stage: 'classroom_scope_fallback', classCode: scope.classCode, errorCode: error.code });
      // Re-read the entire approved scope under one account. Do not combine pages from different accounts.
      return readFallback(scope);
    }
  }
  const listScope = createK67ClassroomScope({ getPortal, getMappings,
    async getClassroomCourse(id) {
      const fields = { fields: 'id,name,courseState' };
      try {
        return await classroomGet('courses/' + id, fields);
      } catch (error) {
        if (!classroomFallbackGet || !canUseFallback(error)) throw error;
        return classroomFallbackGet('courses/' + id, fields);
      }
    } });
  const speaking = createK67SpeakingCta({
    api: speakingApi, docs, lockDocument, ownsScope: nativeStore.ownsScope, log,
    async getSnapshot(scope, { speakingSnapshot } = {}) {
      if (speakingSnapshot?.assignmentCode === scope.assignmentCode) return speakingSnapshot;
      const result = await discover({ ...scope, shared: false, speaking: [scope] });
      return result.speaking[0];
    },
  });
  const legacy = createK67LegacyCta({
    docs,
    async practiceProof(event, context) {
      return context.nativeReceipts.get('reading_practice') ?? readingPractice(event, context);
    },
    async register(event, destination, context) {
      await context.assertOwnership();
      const c = context.source.classroom;
      return { ok: true, ...await store.register({ documentId: event.doc_id, ...destination, classroom: {
        courseId: c.courseId, courseworkId: c.courseworkId, submissionId: c.submissionId,
        studentId: c.studentId, classCode: c.classCode, sourceEventId: c.sourceEventId,
      } }) };
    },
  });
  const bounded = (product, register) => limitK67RegistrarCredentialRetries(register, errorCode =>
    log({ stage: 'registrar_credentials', product, outcome: 'paused', errorCode, pauseMs: 15 * 60_000 }));
  const adapters = createK67ProductAdapters({ readDocument: docs.read,
    readingHomework: bounded('reading_homework', readingHomework),
    listeningHomework: bounded('listening_homework', listeningHomework),
    readingPractice, listeningPractice, speaking: speaking.event, legacy });
  const sourceKey = row => JSON.stringify([row.documentId, row.courseId, row.courseworkId, row.submissionId]);
  const producerStore = { ...store, async sourceBatch({ sources }) {
    const reused = await nativeStore.checkedUnchanged(sources);
    const known = new Set(reused.map(sourceKey));
    const changed = sources.filter(s => !known.has(sourceKey({ ...s.classroom, documentId: s.documentId })));
    const saved = changed.length ? (await store.sourceBatch({ sources: changed })).sources : [];
    return { sources: [...reused, ...saved] };
  } };
  const produce = createClassroomCtaProducer({ store: producerStore, discover,
    publish: nativeStore.publish, ownsScope: nativeStore.ownsScope, withScanLock: createK67NativeScanLock({ pool }),
    log,
    recordOtherSources: writing ? async (scope, sources, runId) => {
      try {
        const { queued } = await writing.discover(scope, sources);
        log({ stage: 'writing_discovery', runId, classCode: scope.classCode, queued });
      } catch (error) {
        log({ stage: 'writing_discovery', runId, classCode: scope.classCode, status: 'unknown',
          errorCode: /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'CTA_WRITING_OUTCOME_UNKNOWN' });
      }
    } : undefined });
  const process = createClassroomCtaProcessor({ store, adapters, verifyProof: verifyK67FinalProof(docs),
    ownsScope: nativeStore.ownsScope, ownsJob: nativeStore.ownsJob, lockDocument,
    // A recovered job rechecks each native link before acknowledging. Registrars avoid repeat writes.
    canReuseProof: () => false, log,
    async prepare({ source, runId, executionId }) {
      const { documentId, classroom: c } = source;
      const initialDocument = await docs.read(documentId);
      if (initialDocument?.documentId !== documentId || !initialDocument.revisionId) {
        throw Object.assign(new Error('CTA_DOC_IDENTITY_MISMATCH'), { code: 'CTA_DOC_IDENTITY_MISMATCH' });
      }
      const speakingCode = findK67SpeakingCode(initialDocument);
      const speakingSnapshot = await verifyCopy({ doc_id: documentId, student_id: c.studentId, submission_id: c.submissionId,
        classroom_course_id: c.courseId, coursework_id: c.courseworkId, class_name: c.classCode }, { speakingCode });
      log({ stage: 'copy_proof', runId, executionId, outcome: speakingSnapshot ? 'shared_speaking' : 'single_copy' });
      return { initialDocument, speakingSnapshot };
    },
  });
  const runtime = createK67CtaRuntime({ nativeStore, listScope, resolveSpeakingCourse, readSpeakingScopes: speakingApi.scopes,
    autoEnroll, onWorkAvailable,
    produce, reconcileSpeaking: speaking.reconcile, processJob: async job => {
      if (await nativeStore.ownsScope({ ...job.source.classroom, epoch: job.epoch }) !== true) return { state: 'held' };
      return process(job);
    }, log });
  const manual = createK67ManualDocuments({ nativeStore, listScope, produce, log,
    async readCodes(docId, record) {
      const document = await docs.read(docId);
      if (document?.documentId !== docId || !document.revisionId) throw Error('CTA_MANUAL_DOC_READBACK_REQUIRED');
      const units = await pool.query('SELECT DISTINCT assignment_code FROM reading_listening67.document_unit WHERE document_id=$1', [docId]);
      const codes = [findK67ReadingHomeworkCode(document, record.courseId), findK67ListeningHomeworkCode(document),
        findK67SpeakingCode(document), ...units.rows.map(x => x.assignment_code)];
      return [...new Set(codes.filter(Boolean))];
    },
  });
  async function manualDocuments(action, docs) {
    try { return await manual(action, docs); }
    finally { if (action === 'submit') onWorkAvailable(); }
  }
  const coordinatedRuntime = writing ? { ...runtime, async workOnce() {
    const result = await runtime.workOnce();
    const writingResult = await writing.workOnce();
    return result.status === 'idle' ? writingResult : result;
  } } : runtime;
  return { runtime: coordinatedRuntime, manualDocuments, async ready() {
    await pool.query('SELECT 1 FROM reading_listening67.cta_native_owner LIMIT 0');
    await pool.query('SELECT 1 FROM reading_listening67.cta_native_job LIMIT 0');
    await pool.query('SELECT 1 FROM reading_listening67.cta_native_slot LIMIT 0');
    if (autoEnroll) {
      const { rows } = await pool.query("SELECT has_function_privilege('reading_listening67.enroll_cta_native_scope(text,text,text,timestamptz)', 'EXECUTE') AS allowed");
      if (rows[0]?.allowed !== true) throw Error('CTA_ENROLLMENT_PERMISSION_REQUIRED');
    }
    if (writing) await pool.query('SELECT 1 FROM reading_listening67.cta_native_writing_source LIMIT 0');
    return store.ready();
  } };
}
