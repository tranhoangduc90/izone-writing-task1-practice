import { createHash } from 'node:crypto';
import { DocsWriteError } from './google.js';

const requestLocations = {
  deleteContentRange: 'range',
  insertText: 'location',
  updateTextStyle: 'range',
  updateParagraphStyle: 'range',
  deleteParagraphBullets: 'range',
};

function checkPlan(plan, document, tabId) {
  if (!plan?.requests?.length || !document.revisionId || plan.revisionId !== document.revisionId) {
    throw new DocsWriteError('DOC_WRITE_UNAVAILABLE');
  }
  for (const request of plan.requests) {
    const keys = Object.keys(request);
    const type = keys[0];
    const location = requestLocations[type];
    if (keys.length !== 1 || !Object.hasOwn(requestLocations, type) || request[type]?.[location]?.tabId !== tabId) {
      throw new DocsWriteError('DOC_REQUEST_SCOPE_MISMATCH');
    }
  }
}

function isFileAccessError(error) {
  return error.status === 404 || (error.status === 403 &&
    ['insufficientFilePermissions', 'PERMISSION_DENIED'].includes(error.reason));
}

async function lacksEditAccess(account, id, count) {
  try {
    return !(await account.canEdit(id, count));
  } catch (error) {
    if (isFileAccessError(error) && error.reason !== 'PERMISSION_DENIED') return true;
    throw error;
  }
}

export async function executeDocsWrite(input, services) {
  const { binding, product, eventId, resultVersion } = input;
  const { accounts, verifySource, loadCurrentProjection, assertWriter, plan, verify,
    recordAttempt, recordRejection = async () => {}, recordVerified = async () => {},
    withDocumentLock, log = () => {} } = services;
  if (!binding?.documentId || !binding?.tabId || !product || !eventId || resultVersion == null) {
    throw new DocsWriteError('DOC_IDENTITY_MISMATCH');
  }
  const { documentId, tabId } = binding;
  const counts = { oauth: 0, profile: 0, read: 0, capability: 0, write: 0 };
  const count = operation => { counts[operation]++; };
  const started = performance.now();
  let lockWaitMs;
  let account;
  let outcome;
  let reason;
  let phase = 'verify_source';
  let failurePhase;
  const result = (value, readback) => {
    outcome = value;
    return { outcome, eventId, resultVersion, accountRole: account.role, writes: counts.write, readback };
  };
  const verified = async (value, document, projection) => {
    phase = 'record_verified';
    await recordVerified({ input, projection, accountRole: account.role, document });
    return result(value, true);
  };
  const read = async () => {
    const document = await account.read(documentId, count);
    if (document.documentId !== documentId) throw new DocsWriteError('DOC_IDENTITY_MISMATCH');
    return document;
  };
  try {
    await verifySource(input);
    phase = 'document_lock';
    return await withDocumentLock(documentId, async () => {
      lockWaitMs = Math.round(performance.now() - started);
      phase = 'load_projection';
      const projection = await loadCurrentProjection(input);
      const confirmedAttempt = projection.reconciliation;
      account = accounts[confirmedAttempt?.accountRole ?? 'primary'];
      if (!account) throw new DocsWriteError('DOC_GOOGLE_CONFIG_INVALID');
      phase = 'verify_account';
      await account.ensureIdentity(count);
      phase = 'read_document';
      let document;
      if (confirmedAttempt) {
        let matches = false;
        try {
          document = await read();
          matches = await verify(document, projection);
        } catch (error) {
          reason = safeCode(error);
        }
        if (matches) return verified('already_current', document, projection);
        return result('needs_reconciliation', false);
      }
      let denied = false;
      try {
        document = await read();
      } catch (error) {
        if (!isFileAccessError(error) || !accounts.fallback) throw error;
        denied = await lacksEditAccess(account, documentId, count);
        if (!denied) throw error;
      }
      if (document && await verify(document, projection)) return verified('already_current', document, projection);
      if (document && !document.revisionId && accounts.fallback) {
        denied = await lacksEditAccess(account, documentId, count);
      }
      if (denied) {
        log({ product, eventId, stage: 'account_fallback', reason: 'DOC_FILE_EDIT_DENIED' });
        account = accounts.fallback;
        await account.ensureIdentity(count);
        try {
          document = await read();
        } catch (error) {
          if (isFileAccessError(error) && await lacksEditAccess(account, documentId, count)) {
            throw new DocsWriteError('DOC_NO_WRITABLE_ACCOUNT');
          }
          throw error;
        }
        if (await verify(document, projection)) return verified('already_current', document, projection);
        if (!document.revisionId && await lacksEditAccess(account, documentId, count)) {
          throw new DocsWriteError('DOC_NO_WRITABLE_ACCOUNT');
        }
      }
      phase = 'plan_write';
      const patch = await plan(document, projection);
      checkPlan(patch, document, tabId);
      phase = 'assert_writer';
      await assertWriter(input, projection);
      phase = 'record_attempt';
      await recordAttempt({ input, projection, accountRole: account.role, revisionId: patch.revisionId });
      phase = 'send_write';
      try {
        await account.write(documentId, patch, count);
      } catch (error) {
        if (!error.uncertain) {
          await recordRejection({ input, projection, code: safeCode(error), accountRole: account.role });
          throw error;
        }
        reason = safeCode(error);
      }
      phase = 'readback';
      let matches = false;
      try {
        document = await read();
        matches = await verify(document, projection);
      } catch (error) {
        reason ??= safeCode(error);
      }
      if (matches) return verified('applied', document, projection);
      reason ??= 'DOC_READBACK_MISMATCH';
      return result('needs_reconciliation', false);
    });
  } catch (error) {
    reason = safeCode(error);
    failurePhase = phase;
    throw error;
  } finally {
    log({ product, eventId, resultVersion, documentTag: createHash('sha256').update(documentId).digest('hex').slice(0, 20),
      stage: 'docs_write', accountRole: account?.role, outcome: outcome ?? 'error', reason, failurePhase, googleCalls: counts, lockWaitMs,
      elapsedMs: Math.round(performance.now() - started) });
  }
}

function safeCode(error) {
  const code = error?.code;
  if (typeof code === 'string' && /^(DOC|DOCS|LESSON4)_[A-Z0-9_]{1,80}$/.test(code)) return code;
  const message = error?.message;
  return typeof message === 'string' && /^DOC_[A-Z0-9_]{1,80}$/.test(message) ? message : 'DOC_EXECUTION_FAILED';
}
