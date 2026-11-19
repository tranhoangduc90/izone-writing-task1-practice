function requireManual(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

// Keep the batch-page result association. Authentication is handled by the operator route.
export function createK67ManualDocuments({ nativeStore, listScope, produce, readCodes, log = () => {} }) {
  return async (action, docs) => {
    requireManual(['submit', 'status'].includes(action) && Array.isArray(docs)
      && docs.length >= 1 && docs.length <= 20, 'CTA_MANUAL_BATCH_INVALID');
    const ids = docs.map(x => x?.docId);
    requireManual(ids.every(id => typeof id === 'string' && /^[A-Za-z0-9_-]{20,200}$/.test(id))
      && new Set(ids).size === ids.length, 'CTA_MANUAL_BATCH_INVALID');
    const response = [];
    for (const docId of ids) {
      let result;
      try {
        const record = await nativeStore.manualSource(docId);
        if (record.status !== 'eligible') {
          result = { docId, status: record.status };
        } else if (record.state === 'ready' && record.proof?.some(p => p.documentId === docId && p.status === 'verified')) {
          const codes = await readCodes(docId, record);
          result = { docId, status: 'registered', codes };
        } else if (action === 'status') {
          result = { docId, status: record.state === 'review' ? 'review'
            : record.enqueued && record.state === 'pending' ? 'queued' : 'not_registered' };
        } else {
          const scope = await listScope({ classCode: record.classCode });
          const course = scope.courses.find(c => c.courseId === record.courseId && c.classCode === record.classCode);
          if (!course) result = { docId, status: 'source_not_found' };
          else {
            const scan = await produce({ ...course, courseWorkId: record.courseWorkId, epoch: record.epoch,
              documentId: docId, speaking: [] });
            result = { docId, status: scan.status === 'done' && scan.published === 1 ? 'queued'
              : scan.status === 'done' && record.state === 'review' ? 'review' : 'unknown' };
          }
        }
      } catch (error) {
        const code = /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'CTA_MANUAL_OUTCOME_UNKNOWN';
        log({ stage: 'manual_document', action, errorCode: code });
        result = { docId, status: code === 'CTA_MANUAL_DOCUMENT_NOT_FOUND' ? 'source_not_found' : 'unknown' };
      }
      response.push(result);
    }
    return { ok: true, results: response };
  };
}
