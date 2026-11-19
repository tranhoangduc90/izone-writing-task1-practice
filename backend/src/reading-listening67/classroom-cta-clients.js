import { request } from 'node:http';

const officialSpeakingPath = '/api/speaking-homework';
const writingSocket = '/run/k67-cta/writing-intake/intake.sock';
const writingMount = '/homework-writing67-api';
const writingIntake = '/api/internal/classroom/register-cta';

function requireClient(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

export function createK67InternalClient({ origin, token, credentialHeader = 'authorization', fetcher = fetch, onRequest = () => {} }) {
  const root = new URL(origin);
  requireClient(['http:', 'https:'].includes(root.protocol) && !root.username && !root.password
    && !root.search && !root.hash && typeof token === 'string' && token.length >= 32
    && ['authorization', 'x-speaking-worker-secret', 'x-reading-admin', 'x-listening-admin',
      'x-homework-cta-key', 'x-api-key', 'x-metabase-session'].includes(credentialHeader),
  'CTA_NATIVE_HTTP_CONFIGURATION_INVALID');
  return async (path, body, search) => {
    requireClient(typeof path === 'string' && /^\/[A-Za-z0-9_/-]+$/.test(path) && !path.startsWith('//'), 'CTA_NATIVE_PATH_INVALID');
    const target = new URL(root.pathname.replace(/\/$/, '') + path, root.origin);
    if (search) target.search = new URLSearchParams(search);
    const method = body === undefined ? 'GET' : 'POST';
    let response;
    try {
      onRequest({ path, method });
      response = await fetcher(target.href, {
        method, redirect: 'error', signal: AbortSignal.timeout(26_000),
        headers: { [credentialHeader]: credentialHeader === 'authorization' ? 'Bearer ' + token : token,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (error) {
      throw Object.assign(new Error('CTA_NATIVE_HTTP_UNAVAILABLE', { cause: error }), { code: 'CTA_NATIVE_HTTP_UNAVAILABLE' });
    }
    let payload;
    try { payload = await response.json(); }
    catch { if (response.ok) requireClient(false, 'CTA_NATIVE_HTTP_RESPONSE_INVALID'); }
    if (!response.ok || payload?.ok === false) {
      const reason = payload?.code ?? payload?.error;
      const code = /^[A-Z0-9_]{1,100}$/.test(reason || '') ? reason : 'CTA_NATIVE_HTTP_' + response.status;
      throw Object.assign(new Error(code), { code, status: response.status });
    }
    requireClient(payload && typeof payload === 'object' && !Array.isArray(payload), 'CTA_NATIVE_HTTP_RESPONSE_INVALID');
    return payload;
  };
}

export function createK67PortalClient({ origin, credentials, apiKey, credentialHeader = 'x-api-key', fetcher = fetch,
  onRequest = () => {} }) {
  if (!credentials) return createK67InternalClient({ origin, token: apiKey, credentialHeader, fetcher, onRequest });
  const endpoint = new URL(origin);
  requireClient(endpoint.href === 'https://metabase.izone.edu.vn/' && !apiKey && credentials
    && typeof credentials.username === 'string' && credentials.username.trim() !== ''
    && typeof credentials.password === 'string' && credentials.password !== '', 'CTA_PORTAL_CREDENTIALS_INVALID');

  let session;
  async function authenticate() {
    const path = '/api/session';
    onRequest({ path, method: 'POST' });
    let response;
    try {
      response = await fetcher(new URL(path, endpoint).href, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: credentials.username, password: credentials.password }),
      });
    } catch {
      throw Object.assign(new Error('CTA_PORTAL_AUTH_UNAVAILABLE'), { code: 'CTA_PORTAL_AUTH_UNAVAILABLE' });
    }
    requireClient(response.ok, 'CTA_PORTAL_AUTH_HTTP_' + response.status);
    const result = await response.json().catch(() => null);
    requireClient(typeof result?.id === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(result.id), 'CTA_PORTAL_SESSION_INVALID');
    return createK67InternalClient({ origin, token: result.id, credentialHeader: 'x-metabase-session', fetcher, onRequest });
  }

  function getSession() {
    session ??= authenticate().catch(error => { session = undefined; throw error; });
    return session;
  }

  return async (path, body) => {
    requireClient(path === '/api/dataset' && body !== undefined, 'CTA_PORTAL_PATH_INVALID');
    const current = getSession();
    try { return await (await current)(path, body); }
    catch (error) {
      if (error.status !== 401) throw error;
      if (session === current) session = undefined;
      return (await getSession())(path, body);
    }
  };
}

export function createK67WritingSocketClient({ socketPath, token, onRequest }) {
  requireClient(socketPath === writingSocket, 'CTA_WRITING_SOCKET_CONFIGURATION_INVALID');
  const origin = 'http://writing-cta.internal' + writingMount;
  const fetcher = (url, { method, headers, body, signal }) => {
    requireClient(url === origin + writingIntake && method === 'POST' && typeof body === 'string', 'CTA_WRITING_SOCKET_ROUTE_INVALID');
    return new Promise((resolve, reject) => {
      const connection = request({ socketPath, path: writingMount + writingIntake, method, signal, agent: false,
        headers: { ...headers, host: 'ducizone.ddns.net', 'content-length': Buffer.byteLength(body) },
      }, async response => {
        try {
          const chunks = [];
          let bytes = 0;
          for await (const chunk of response) {
            bytes += chunk.length;
            if (bytes > 64 * 1024) throw Error('CTA_WRITING_SOCKET_RESPONSE_TOO_LARGE');
            chunks.push(chunk);
          }
          const status = response.statusCode;
          const payload = [204, 205, 304].includes(status) ? null : Buffer.concat(chunks);
          resolve(new Response(payload, { status, headers: { 'content-type': response.headers['content-type'] ?? '' } }));
        } catch (error) { reject(error); }
      });
      connection.on('error', reject);
      connection.end(body);
    });
  };
  const post = createK67InternalClient({ origin, token, credentialHeader: 'x-homework-cta-key', fetcher, onRequest });
  return event => post(writingIntake, event);
}

export function createK67SpeakingClient(request) {
  const prefix = officialSpeakingPath + '/internal/';
  async function result(name, input, field = 'result') {
    const payload = await request(prefix + name, input);
    requireClient(payload?.ok === true && payload[field] && typeof payload[field] === 'object', 'CTA_SPEAKING_RECEIPT_INVALID');
    return payload[field];
  }
  return {
    scopes: () => request(prefix + 'assignments/scopes'),
    register: input => result('assignments/register', input),
    sync: input => result('classroom-copies/sync', input),
    plan: input => result('classroom-copies/plan', input, 'plan'),
    verify: input => result('classroom-copies/verify', input),
  };
}

export function createK67MappingReader({ pool }) {
  return async classes => {
    const { rows } = await pool.query(`
      SELECT m.erp_course_class_id::text AS "erpClassId", m.classroom_course_id AS "courseId", m.status,
        (SELECT count(*)::int FROM mapping.classroom_course_mapping other
         WHERE other.status='approved' AND other.classroom_course_id=m.classroom_course_id) AS "approvedCourseReferences"
      FROM mapping.classroom_course_mapping m WHERE m.erp_course_class_id=ANY($1::bigint[])`,
    [classes.map(c => c.erpClassId)]);
    return rows;
  };
}
