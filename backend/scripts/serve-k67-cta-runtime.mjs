import { readFileSync } from 'node:fs';
import { OAuth2Client } from 'google-auth-library';
import { Pool } from 'pg';
import { createClassroomReadOnlyClient } from '../src/reading-listening67/classroom-cta-google.js';
import { createK67InternalClient, createK67MappingReader, createK67SpeakingClient } from '../src/reading-listening67/classroom-cta-clients.js';
import { createK67CtaStack } from '../src/reading-listening67/classroom-cta-stack.js';
import { createReading67GoogleDocs } from '../src/reading-listening67/web-homework-docs.js';
import { verifyClassroomCopy } from '../src/reading-listening67/cta-confirmation-client.js';
import { createK67CtaHttp, createK67CtaWorkSignal, startK67CtaLoops } from '../src/reading-listening67/classroom-cta-http.js';
import { createK67WritingRegistry } from '../src/reading-listening67/classroom-cta-writing.js';
import { createSharedTeacherVerifier } from '../src/teacher-sso/consumer.js';

if (!process.env.K67_CTA_RUNTIME_CONFIG) throw Error('CTA_RUNTIME_CONFIG_MISSING');
const config = JSON.parse(readFileSync(process.env.K67_CTA_RUNTIME_CONFIG, 'utf8'));
const secret = path => readFileSync(path, 'utf8').trim();
const log = event => console.log(JSON.stringify({ time: new Date().toISOString(), ...event }));
const id = /^[1-9][0-9]{0,19}$/;
if (!['127.0.0.1', '0.0.0.0'].includes(config.listenHost) || !Number.isInteger(config.listenPort)
  || config.listenPort < 1024 || config.listenPort > 65535 || !Number.isInteger(config.portal.databaseId)
  || config.docsAccount !== 'ielts.izone@gmail.com' || typeof config.enabled !== 'boolean') throw Error('CTA_RUNTIME_CONFIGURATION_INVALID');

const pool = new Pool({ connectionString: secret(config.ctaDatabaseFile), max: 4, connectionTimeoutMillis: 4000 });
const mappingPool = new Pool({ connectionString: secret(config.mappingDatabaseFile), max: 2, connectionTimeoutMillis: 4000 });
for (const connection of [pool, mappingPool]) connection.on('error', () => log({ stage: 'postgres', errorCode: 'CTA_DB_CONNECTION_LOST' }));
const getMappings = createK67MappingReader({ pool: mappingPool });
function client(item, credentialHeader = 'authorization') {
  return createK67InternalClient({ origin: item.origin, token: secret(item.keyFile), credentialHeader,
    onRequest: ({ path, method }) => log({ stage: 'native_api', path, method }) });
}
const metabase = client(config.portal, config.portal.credentialHeader ?? 'x-api-key');
const portalSql = `
SELECT JSON_OBJECT(
  'schemaVersion', 1, 'source', 'portal_erp_live',
  'observedAt', DATE_FORMAT(UTC_TIMESTAMP(), '%Y-%m-%dT%H:%i:%sZ'),
  'count', COUNT(*),
  'classes', COALESCE(JSON_ARRAYAGG(JSON_OBJECT(
    'erpClassId', cc.id, 'classCode', cc.name, 'courseId', c.id,
    'courseShortName', c.short_name, 'status', cc.status,
    'classDeletedAt', cc.deleted_at, 'courseDeletedAt', c.deleted_at
  )), JSON_ARRAY())
) AS payload
FROM course_classes cc JOIN courses c ON c.id=cc.course_id
WHERE c.short_name='67' AND c.deleted_at IS NULL AND cc.deleted_at IS NULL AND cc.status='on_going'`;
const getPortal = () => metabase('/api/dataset', { database: config.portal.databaseId, type: 'native', native: { query: portalSql } });
const classroomGet = createClassroomReadOnlyClient({ file: config.classroomOAuthFile, account: config.docsAccount,
  onRequest: () => log({ stage: 'google', product: 'classroom', account: 'izone', method: 'GET' }) });
const classroomFallbackGet = config.classroomFallbackOAuthFile ? createClassroomReadOnlyClient({
  file: config.classroomFallbackOAuthFile, account: 'tranhoangduc90@gmail.com',
  onRequest: () => log({ stage: 'google', product: 'classroom', account: 'fallback', method: 'GET' }),
}) : undefined;
const docCredential = JSON.parse(secret(config.docsOAuthFile));
const auth = new OAuth2Client(docCredential.client_id ?? docCredential.clientId, docCredential.client_secret ?? docCredential.clientSecret);
auth.setCredentials({ refresh_token: docCredential.refresh_token ?? docCredential.refreshToken });
const access = await auth.getAccessToken();
const profile = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
  headers: { authorization: 'Bearer ' + access.token }, signal: AbortSignal.timeout(10000), redirect: 'error',
});
if (!profile.ok || (await profile.json()).user?.emailAddress !== config.docsAccount) throw Error('CTA_DOCS_ACCOUNT_MISMATCH');
const traceGoogle = (url, options) => {
  const parsed = new URL(url);
  if (!['docs.googleapis.com', 'classroom.googleapis.com', 'www.googleapis.com'].includes(parsed.hostname)
    || parsed.protocol !== 'https:') throw Error('CTA_GOOGLE_DESTINATION_INVALID');
  log({ stage: 'google', product: parsed.hostname, method: options?.method || 'GET' });
  return fetch(url, { ...options, redirect: 'error' });
};
const docs = createReading67GoogleDocs(auth, { fetcher: traceGoogle });
const verifyCopy = verifyClassroomCopy(auth, { fetcher: traceGoogle });
const speakingApi = createK67SpeakingClient(client(config.speaking, 'x-speaking-worker-secret'));
const readingHomework = client(config.readingHomework);
const listeningHomework = client(config.listeningHomework);
const readingPractice = client(config.readingPractice, 'x-reading-admin');
const listeningPractice = client(config.listeningPractice, 'x-listening-admin');
const writingPool = config.writing?.enabled === true ? new Pool({
  connectionString: secret(config.writing.registryReadonlyFile), max: 1, connectionTimeoutMillis: 4000,
}) : null;
writingPool?.on('error', () => log({ stage: 'postgres', errorCode: 'CTA_WRITING_REGISTRY_CONNECTION_LOST' }));
const writingClient = writingPool ? client(config.writing, 'x-homework-cta-key') : null;
const workSignal = createK67CtaWorkSignal();

const { runtime, manualDocuments, ready } = createK67CtaStack({
  pool, getPortal, getMappings, classroomGet, classroomFallbackGet, docs, verifyCopy, speakingApi, log,
  onWorkAvailable: workSignal.notify,
  writingConfiguration: writingPool ? {
    readRegistry: createK67WritingRegistry({ pool: writingPool }),
    submit: event => writingClient('/api/internal/classroom/register-cta', event),
  } : undefined,
  readingHomework: event => readingHomework('/api/reading-skills67/admin/register-cta', event),
  listeningHomework: (event, assignmentCode) => listeningHomework('/api/listening-homework67/admin/register-cta', event, { assignmentCode }),
  readingPractice: event => readingPractice('/api/admin/register-cta', event),
  listeningPractice: event => listeningPractice('/api/admin/register-cta', event),
  async resolveSpeakingCourse(scope) {
    // Registry scopes absent from Portal can be included only with an explicitly approved ERP pair.
    const erpClassId = config.extraSpeakingClasses?.[scope.classCode];
    if (!id.test(erpClassId || '')) throw Error('SPEAKING_CLASSROOM_APPROVAL_MISSING');
    const approved = (await getMappings([{ erpClassId }])).filter(row => row.status === 'approved');
    if (approved.length !== 1 || approved[0].courseId !== scope.courseId || approved[0].approvedCourseReferences !== 1) {
      throw Error('SPEAKING_CLASSROOM_APPROVAL_MISSING');
    }
    const row = await classroomGet('courses/' + scope.courseId, { fields: 'id,name,courseState' });
    if (row.id !== scope.courseId || row.courseState !== 'ACTIVE' || !row.name) throw Error('SPEAKING_CLASSROOM_UNAVAILABLE');
    return { classCode: scope.classCode, courseId: scope.courseId, classroomName: row.name };
  },
});
await ready();
const activeRuntime = config.enabled ? runtime : {
  async manual() { throw Object.assign(new Error('CTA_RUNTIME_STANDBY'), { code: 'CTA_RUNTIME_STANDBY' }); },
};
let manualPage;
if (config.enabled && config.manualPage?.enabled === true) {
  const page = config.manualPage;
  const origin = new URL(page.origin);
  const ssoUrl = new URL(page.ssoUrl);
  const subjects = JSON.parse(secret(page.operatorSubjectsFile));
  if (origin.protocol !== 'https:' || origin.origin !== page.origin || !['http:', 'https:'].includes(ssoUrl.protocol)
    || ssoUrl.pathname !== '/internal/identity/k67-cta' || ssoUrl.username || ssoUrl.password || ssoUrl.search || ssoUrl.hash
    || !Array.isArray(subjects) || !subjects.length || subjects.some(subject => !/^[0-9]{10,32}$/.test(subject) || typeof subject !== 'string')) {
    throw Error('CTA_OPERATOR_CONFIGURATION_INVALID');
  }
  const operators = new Set(subjects);
  const verify = createSharedTeacherVerifier({ url: ssoUrl.href, key: secret(page.ssoKeyFile),
    fetcher: (url, options) => fetch(url, { ...options, redirect: 'error' }) });
  manualPage = { origin: origin.origin, async authorize(request) {
    const identity = await verify(request);
    if (!operators.has(identity.sub)) throw Object.assign(Error('CTA_OPERATOR_FORBIDDEN'), { status: 403 });
  } };
}
const server = createK67CtaHttp({ runtime: activeRuntime, manualDocuments: config.enabled ? manualDocuments : undefined,
  manualPage, token: secret(config.operatorTokenFile), ready, log });
server.listen(config.listenPort, config.listenHost, () => log({ stage: 'runtime', mode: config.enabled ? 'active' : 'standby' }));
const stop = config.enabled ? startK67CtaLoops({ runtime, workSignal, log }) : async () => {};
let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  await Promise.all([stop(), new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))]);
  await Promise.all([pool.end(), mappingPool.end(), writingPool?.end()]);
}
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => shutdown().catch(() => {
  log({ stage: 'shutdown', errorCode: 'CTA_SHUTDOWN_INCOMPLETE' });
  process.exitCode = 1;
}));
