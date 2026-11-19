import { readFileSync } from 'node:fs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function retryDelay(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, time - Date.now()) : 0;
}

async function credentials(file, expectedAccount) {
  const config = JSON.parse(readFileSync(file, 'utf8'));
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: config.client_id || config.clientId,
      client_secret: config.client_secret || config.clientSecret,
      refresh_token: config.refresh_token || config.refreshToken,
      grant_type: 'refresh_token',
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw Error('CTA_GOOGLE_AUTH_' + response.status);
  const grant = await response.json();
  const scopes = String(grant.scope || '').split(/\s+/);
  if (!scopes.includes('https://www.googleapis.com/auth/classroom.student-submissions.students.readonly')
      || scopes.some(scope => scope.includes('/auth/classroom.') && !scope.endsWith('.readonly')
        && scope !== 'https://www.googleapis.com/auth/classroom.profile.emails')) {
    throw Error('CTA_GOOGLE_READ_SCOPE_REQUIRED');
  }
  const headers = { authorization: 'Bearer ' + grant.access_token };
  const identity = await fetch('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', {
    headers, signal: AbortSignal.timeout(10_000),
  });
  if (!identity.ok || (await identity.json()).user?.emailAddress !== expectedAccount) {
    throw Error('CTA_GOOGLE_ACCOUNT_MISMATCH');
  }
  return { headers, validUntil: Date.now() + Math.max(0, Number(grant.expires_in || 0) - 60) * 1000 };
}

export function createClassroomReadOnlyClient({ file, account, onRequest = () => {} }) {
  let grant;
  return async (path, params) => {
    if (!/^courses\/[0-9]+(?:\/courseWork(?:\/[0-9]+(?:\/studentSubmissions)?)?)?$/.test(path)) {
      throw Object.assign(Error('CTA_CLASSROOM_PATH_INVALID'), { code: 'CTA_CLASSROOM_PATH_INVALID' });
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!grant || Date.now() >= grant.validUntil) grant = await credentials(file, account);
      onRequest();
      const response = await fetch('https://classroom.googleapis.com/v1/' + path + '?' + new URLSearchParams(params), {
        method: 'GET', headers: grant.headers, signal: AbortSignal.timeout(15_000),
      });
      if (response.ok) return response.json();
      const retryAfter = retryDelay(response.headers.get('Retry-After'));
      if (response.status === 401) grant = null;
      if ((![401, 429].includes(response.status) && response.status < 500) || attempt === 2 || retryAfter > 30_000) {
        const code = 'CTA_CLASSROOM_GET_' + response.status;
        throw Object.assign(Error(code), { code });
      }
      await delay(Math.max(500 * 2 ** attempt, retryAfter));
    }
  };
}
