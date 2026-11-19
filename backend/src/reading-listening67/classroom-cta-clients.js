const officialSpeakingPath = '/api/speaking-homework';

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
    catch { requireClient(false, 'CTA_NATIVE_HTTP_RESPONSE_INVALID'); }
    if (!response.ok || payload?.ok === false) {
      const reason = payload?.code ?? payload?.error;
      const code = /^[A-Z0-9_]{1,100}$/.test(reason || '') ? reason : 'CTA_NATIVE_HTTP_' + response.status;
      requireClient(false, code);
    }
    requireClient(payload && typeof payload === 'object' && !Array.isArray(payload), 'CTA_NATIVE_HTTP_RESPONSE_INVALID');
    return payload;
  };
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
