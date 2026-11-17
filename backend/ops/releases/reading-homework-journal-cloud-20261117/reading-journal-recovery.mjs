import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const digest = /^[a-f0-9]{64}$/;
const maximumBindings = 16;

export function createReadingJournalRecovery({ db, journal, canonical, storageScope, readingHomeworkBinding, cloudTicket, readMode }) {
  // Only the authenticated native scope supplies owner, class and assignment.
  // The browser contributes opaque hashes from its outbox.
  return async function recover(scope, bindingIds, lane = 'collector') {
    if (!Array.isArray(bindingIds) || !bindingIds.length || bindingIds.length > maximumBindings
      || bindingIds.some(id => typeof id !== 'string' || !digest.test(id))) {
      throw Object.assign(new Error('READING_JOURNAL_BINDINGS_INVALID'), { status: 400 });
    }
    if (lane === 'preferred') {
      // Collector mode uses the grant already returned by the native draft.
      if (!cloudTicket || await readMode?.() !== 'cloud') return [];
      lane = 'cloud';
    }
    if (lane === 'cloud' && !cloudTicket) return [];
    const pending = new Set(bindingIds);
    const values = [scope.ownerId, scope.courseId, scope.code, String(scope.version)];
    const { rows } = await db.query(`
      SELECT content_version AS version, run_no
      FROM reading_listening67.web_draft
      WHERE owner_id=$1 AND course_id=$2 AND assignment_code=$3
      UNION
      SELECT content_version, run_no
      FROM reading_listening67.web_draft_archive
      WHERE owner_id=$1 AND course_id=$2 AND assignment_code=$3
      UNION
      SELECT content_version, run_no
      FROM reading_listening67.web_attempt
      WHERE owner_id=$1 AND course_id=$2 AND assignment_code=$3
      UNION
      SELECT $4::text, 1
      WHERE NOT EXISTS (
        SELECT 1 FROM reading_listening67.web_draft
        WHERE owner_id=$1 AND course_id=$2 AND assignment_code=$3 AND content_version=$4
      )
    `, values);
    const result = [];
    for (const row of rows) {
      if (!pending.size) break;
      if (!Number.isSafeInteger(row.run_no) || row.run_no < 1) continue;
      const candidate = { ...scope, version: row.version };
      const bound = storageScope(readingHomeworkBinding({ ...candidate, runNo: row.run_no }));
      const bindingId = createHash('sha256').update(canonical(bound)).digest('hex');
      if (!pending.has(bindingId)) continue;
      const context = lane === 'cloud' ? { bindingId, ...cloudTicket.issue(bound) } : await journal.context(candidate, row.run_no);
      if (context?.bindingId !== bindingId) continue;
      result.push({ ...context, archiveLane: lane });
      pending.delete(bindingId);
    }
    return result;
  };
}

export function stageReadingRecoveryRouter(source) {
  const anchor = "  router.get('/lesson',";
  if (source.split(anchor).length !== 2
    || source.indexOf("router.use(async(q,r,next)=>{try{requireOpen();q.webIdentity=await authenticate(q);") === -1) {
    throw new Error('READING_NATIVE_ROUTER_BASELINE_MISMATCH');
  }
  const handler = `  if(journal?.recoverContexts){
    router.post('/journal-context',route(async(q,r)=>{
      r.set('Cache-Control','no-store');
      const input=parse(z.object({bindingIds:z.array(z.string().regex(/^[a-f0-9]{64}$/)).min(1).max(16),lane:z.enum(['preferred','cloud','collector']).optional()}).strict(),q.body);
      const contexts=await journal.recoverContexts(scope(q),input.bindingIds,input.lane);
      r.json({ok:true,contexts});
    }));
  }
`;
  if (!source.includes('ownerEntry,journal}){')) throw new Error('READING_NATIVE_JOURNAL_OVERLAY_MISSING');
  return source.replace(anchor, handler + anchor);
}

export async function enableReadingJournalRecovery({ db, journal, env = process.env }) {
  if (!journal) return;
  try {
    const root = env.EXAM_JOURNAL_LIBRARY_ROOT || '/opt/exam-journal';
    const load = name => import(pathToFileURL(resolve(root, name)).href);
    const [{ canonical }, { storageScope }, { readingHomeworkBinding }, { createTicketCodec }] = await Promise.all([
      load('src/contract.mjs'), load('src/product-record.mjs'), load('adapters/reading-homework.mjs'), load('src/ticket.mjs'),
    ]);
    const modeFile = env.READING_JOURNAL_BROWSER_MODE_FILE;
    const keyFile = env.READING_JOURNAL_BROWSER_KEY_FILE;
    const keyId = env.READING_JOURNAL_BROWSER_KEY_ID;
    let cloudTicket;
    if (keyFile && isAbsolute(keyFile) && /^[a-zA-Z0-9_-]{1,40}$/.test(keyId || '')) {
      try {
        const key = Buffer.from((await readFile(keyFile, 'utf8')).trim(), 'base64');
        cloudTicket = createTicketCodec({ keys: { [keyId]: key }, currentKeyId: keyId });
      } catch {
        console.error(JSON.stringify({ type: 'learning_journal_health', status: 'degraded', errorCode: 'READING_CLOUD_TICKET_UNAVAILABLE' }));
      }
    }
    async function readMode() {
      if (!modeFile || !isAbsolute(modeFile)) return 'collector';
      try { return (await readFile(modeFile, 'utf8')).trim() === 'cloud' ? 'cloud' : 'collector'; }
      catch { return 'collector'; }
    }
    journal.recoverContexts = createReadingJournalRecovery({
      db, journal, canonical, storageScope, readingHomeworkBinding, cloudTicket, readMode,
    });
  } catch {
    console.error(JSON.stringify({ type: 'learning_journal_health', status: 'degraded', errorCode: 'READING_JOURNAL_RECOVERY_UNAVAILABLE' }));
  }
}

export function stageReadingRecoveryEntry(source) {
  const imports = "import {startHomeworkJournal,stopHomeworkJournal} from '../src/reading-listening67/web-journal-runtime.js';";
  const afterDatabase = "const content=JSON.parse(await fs.readFile(config.contentPath,'utf8'));";
  if (source.split(imports).length !== 2 || source.split(afterDatabase).length !== 2
    || !source.includes("startHomeworkJournal({productId:'reading-homework'")) {
    throw new Error('READING_NATIVE_ENTRY_BASELINE_MISMATCH');
  }
  const helper = "import {enableReadingJournalRecovery} from '/run/reading-journal-cloud/reading-journal-recovery.mjs';";
  return source.replace(imports, imports + '\n' + helper)
    .replace(afterDatabase, 'await enableReadingJournalRecovery({db,journal});\n' + afterDatabase);
}
