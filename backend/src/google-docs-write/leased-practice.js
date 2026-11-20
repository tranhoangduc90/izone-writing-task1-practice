import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { executeDocsWrite } from './execute.js';
import { createGoogleDocsAccount, createGoogleDocsTokenProvider, DocsWriteError } from './google.js';
import { createDocsDocumentLock } from './lock.js';

const jobTables = {
  'reading-practice': 'reading_practice.doc_job',
  'listening-practice': 'listening_practice.doc_job',
};
const liveLease = "id=$1 AND lease_id=$2 AND status='processing' AND lease_until>now()";

function ownedRow(result) {
  if (!result.rows[0]) throw new DocsWriteError('DOC_LEASE_LOST');
  return result.rows[0];
}

export function createLeasedPracticeWriter({ pool, product, accounts, withDocumentLock, log }) {
  const table = Object.hasOwn(jobTables, product) && jobTables[product];
  if (!table) throw new DocsWriteError('DOC_PRODUCT_NOT_SUPPORTED');
  const bindings = table.replace(/\.doc_job$/, '.binding');

  return async ({ job, binding, plan, observe, acknowledge }) => {
    const { document_id: documentId, tab_id: tabId } = binding;
    const lease = [job.id, job.leaseId];
    const assertSource = () => {
      if (job.kind !== 'status' || job.binding_id !== binding.id || !documentId || !tabId) {
        throw new DocsWriteError('DOC_IDENTITY_MISMATCH');
      }
    };
    const traced = Object.fromEntries(Object.entries(accounts).map(([role, account]) => [role, {
      ...account,
      read(id, count) {
        return observe.read({ read: target => account.read(target, count) }, id);
      },
      write(id, patch, count) {
        return observe.write({ write: (target, request) => account.write(target, request, count) }, id, patch);
      },
    }]));

    const result = await executeDocsWrite({ product, eventId: job.id, resultVersion: job.sequence,
      binding: { documentId, tabId } }, {
      accounts: traced, withDocumentLock, log,
      verifySource: assertSource,
      assertWriter: assertSource,
      async loadCurrentProjection() {
        const row = ownedRow(await pool.query('SELECT shared_docs_attempt FROM ' + table + ' WHERE ' + liveLease, lease));
        const attempt = row.shared_docs_attempt;
        if (attempt && (attempt.documentId !== documentId || attempt.tabId !== tabId)) {
          throw new DocsWriteError('DOC_TARGET_CHANGED');
        }
        return { reconciliation: attempt };
      },
      plan,
      verify: document => plan(document).verified,
      async recordAttempt({ accountRole, revisionId }) {
        const attempt = JSON.stringify({ accountRole, revisionId, documentId, tabId });
        // A shared link can discover its personal Homework after the job was queued.
        ownedRow(await pool.query('UPDATE ' + table + ' SET shared_docs_attempt=$3::jsonb WHERE ' + liveLease +
          ' AND shared_docs_attempt IS NULL AND binding_id=$4' +
          ' AND EXISTS (SELECT 1 FROM ' + bindings + ' b WHERE b.id=$4' +
          " AND COALESCE(b.document_id,b.owner_proof->'homework'->>'documentId')=$5" +
          " AND COALESCE(b.tab_id,b.owner_proof->'homework'->>'tabId')=$6) RETURNING id",
        [...lease, attempt, binding.id, documentId, tabId]));
      },
      async recordRejection() {
        ownedRow(await pool.query('UPDATE ' + table + ' SET shared_docs_attempt=NULL WHERE ' + liveLease + ' RETURNING id', lease));
      },
      async recordVerified() {
        if (!await acknowledge()) throw new DocsWriteError('DOC_LEASE_LOST');
      },
    });
    if (!result.readback) throw new DocsWriteError('DOC_NEEDS_RECONCILIATION');
    return true;
  };
}

export async function loadLeasedPracticeWriter(file, { Pool, pool, product }) {
  if (!file) return null;
  const config = JSON.parse(await readFile(file, 'utf8'));
  const { all = false, classIds = [], primaryCredentialsFile, fallbackCredentialsFile, lockDatabaseFile } = config;
  const table = Object.hasOwn(jobTables, product) && jobTables[product];
  if (!table || typeof all !== 'boolean' || !Array.isArray(classIds) || (!all && !classIds.length) ||
      !classIds.every(id => typeof id === 'string' && /^[1-9][0-9]{0,17}$/.test(id)) ||
      ![primaryCredentialsFile, fallbackCredentialsFile, lockDatabaseFile].every(p => typeof p === 'string' && isAbsolute(p))) {
    throw new DocsWriteError('DOC_GOOGLE_CONFIG_INVALID');
  }
  await pool.query('SELECT shared_docs_attempt FROM ' + table + ' LIMIT 0');
  const accounts = Object.fromEntries(await Promise.all(Object.entries({
    primary: primaryCredentialsFile, fallback: fallbackCredentialsFile,
  }).map(async ([role, path]) => {
    const credentials = JSON.parse(await readFile(path, 'utf8'));
    return [role, createGoogleDocsAccount({ role, getToken: createGoogleDocsTokenProvider({ credentials }) })];
  })));
  const lockPool = new Pool({ connectionString: (await readFile(lockDatabaseFile, 'utf8')).trim(),
    max: 2, connectionTimeoutMillis: 4_000, application_name: product + '-docs-lock' });
  const log = values => console.log(JSON.stringify({ event: 'practice_shared_docs', ...values }));
  lockPool.on('error', () => log({ product, stage: 'lock_connection_lost' }));
  const classes = new Set(classIds);
  return {
    applies: classId => all || classes.has(String(classId)),
    write: createLeasedPracticeWriter({ pool, product, accounts, withDocumentLock: createDocsDocumentLock(lockPool), log }),
    close: () => lockPool.end(),
  };
}
