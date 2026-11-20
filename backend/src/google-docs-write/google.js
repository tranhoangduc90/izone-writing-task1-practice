const docsRoot = 'https://docs.googleapis.com/v1/documents/';
const driveRoot = 'https://www.googleapis.com/drive/v3/';

export const docsAccountEmails = Object.freeze({
  primary: 'ielts.izone@gmail.com',
  fallback: 'tranhoangduc90@gmail.com',
});

export class DocsWriteError extends Error {
  constructor(code, detail = {}) {
    super(code);
    this.code = code;
    Object.assign(this, detail);
  }
}

export function createGoogleDocsTokenProvider({ credentials, fetcher = fetch, now = Date.now }) {
  const clientId = credentials?.clientId ?? credentials?.client_id;
  const clientSecret = credentials?.clientSecret ?? credentials?.client_secret;
  const refreshToken = credentials?.refreshToken ?? credentials?.refresh_token;
  if ([clientId, clientSecret, refreshToken].some(value => typeof value !== 'string' || !value.trim())) {
    throw new DocsWriteError('DOC_GOOGLE_CONFIG_INVALID');
  }
  let current;
  let refreshing;
  return async ({ refresh = false, rejectedToken, count = () => {} } = {}) => {
    if (current?.expiresAt > now() + 60_000 && (!refresh || current.token !== rejectedToken)) return current.token;
    refreshing ??= (async () => {
      count('oauth');
      try {
        const result = await fetcher('https://oauth2.googleapis.com/token', {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5_000),
          body: new URLSearchParams({ grant_type: 'refresh_token', client_id: clientId,
            client_secret: clientSecret, refresh_token: refreshToken }),
        });
        if (!result.ok) throw new DocsWriteError('DOC_GOOGLE_AUTH_UNAVAILABLE');
        const { access_token, expires_in } = await result.json();
        if (typeof access_token !== 'string' || !access_token || !Number.isFinite(Number(expires_in))) {
          throw new DocsWriteError('DOC_GOOGLE_AUTH_UNAVAILABLE');
        }
        current = { token: access_token, expiresAt: now() + Number(expires_in) * 1000 };
        return current.token;
      } catch {
        throw new DocsWriteError('DOC_GOOGLE_AUTH_UNAVAILABLE');
      }
    })().finally(() => { refreshing = undefined; });
    return refreshing;
  };
}

function documentPath(id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{5,120}$/.test(id)) {
    throw new DocsWriteError('DOC_IDENTITY_MISMATCH');
  }
  return encodeURIComponent(id);
}

export function createGoogleDocsAccount({ role, getToken, fetcher = fetch }) {
  const email = docsAccountEmails[role];
  if (!Object.hasOwn(docsAccountEmails, role) || typeof getToken !== 'function') {
    throw new DocsWriteError('DOC_GOOGLE_CONFIG_INVALID');
  }

  async function request(url, { body, count, operation }) {
    const method = body ? 'POST' : 'GET';
    let rejectedToken;
    for (let pass = 0; pass < 2; pass++) {
      const token = await getToken({ refresh: pass === 1, rejectedToken, count });
      if (!token) throw new DocsWriteError('DOC_GOOGLE_AUTH_UNAVAILABLE');
      count(operation);
      let response;
      try {
        response = await fetcher(url, {
          method, redirect: 'error', signal: AbortSignal.timeout(10_000),
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          ...(body && { body: JSON.stringify(body) }),
        });
      } catch {
        throw new DocsWriteError('DOC_TRANSPORT_UNAVAILABLE', { uncertain: method === 'POST' });
      }
      if (response.status === 401 && pass === 0) {
        rejectedToken = token;
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        const reason = payload?.error?.errors?.[0]?.reason || payload?.error?.status;
        throw new DocsWriteError(`DOC_HTTP_${response.status}`, {
          status: response.status,
          reason: /^[a-z_]{1,80}$/i.test(reason ?? '') ? reason : undefined,
          retryAfter: response.headers.get('retry-after'),
          uncertain: method === 'POST' && (response.status === 408 || response.status >= 500),
        });
      }
      try {
        return await response.json();
      } catch {
        throw new DocsWriteError('DOC_RESPONSE_INVALID', { uncertain: method === 'POST' });
      }
    }
  }

  let identity;
  return {
    role,
    ensureIdentity(count) {
      identity ??= request(driveRoot + 'about?fields=user(emailAddress)', { count, operation: 'profile' })
        .then(profile => {
          if (profile.user?.emailAddress !== email) throw new DocsWriteError('DOC_ACCOUNT_MISMATCH');
        }).catch(error => {
          identity = undefined;
          throw error;
        });
      return identity;
    },
    read(id, count) {
      return request(docsRoot + documentPath(id) + '?includeTabsContent=true', { count, operation: 'read' });
    },
    async canEdit(id, count) {
      const file = await request(driveRoot + 'files/' + documentPath(id) + '?fields=id,capabilities(canEdit)&supportsAllDrives=true',
        { count, operation: 'capability' });
      if (file.id !== id || typeof file.capabilities?.canEdit !== 'boolean') {
        throw new DocsWriteError('DOC_CAPABILITY_UNVERIFIED');
      }
      return file.capabilities.canEdit;
    },
    write(id, { revisionId, requests }, count) {
      if (typeof revisionId !== 'string' || !revisionId.trim()) throw new DocsWriteError('DOC_WRITE_UNAVAILABLE');
      return request(docsRoot + documentPath(id) + ':batchUpdate', {
        body: { writeControl: { requiredRevisionId: revisionId }, requests }, count, operation: 'write',
      });
    },
  };
}
