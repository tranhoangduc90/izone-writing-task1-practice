import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { assessSharedCta, classroomSourceKey, createClassroomCtaDiscovery } from '../src/reading-listening67/classroom-cta-discovery.js';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = rows => createHash('sha256').update(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())).digest('hex');

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
  return headers;
}

async function main() {
  const { account, scopes, sourceSnapshot, observedAt } = JSON.parse(readFileSync(0, 'utf8'));
  const oauthFile = process.env.K67_CTA_READ_OAUTH_FILE;
  if (!oauthFile || typeof account !== 'string' || !Array.isArray(scopes) || !scopes.length
      || scopes.length > 200 || new Set(scopes.map(scope => scope.courseId)).size !== scopes.length) {
    throw Error('CTA_SHADOW_SCOPE_CONFIGURATION_INVALID');
  }
  const now = Date.parse(observedAt);
  if (sourceSnapshot && (!Number.isFinite(now) || !/(?:Z|[+-]\d\d:\d\d)$/.test(observedAt))) {
    throw Error('CTA_SHADOW_OBSERVATION_TIME_INVALID');
  }
  const headers = await credentials(oauthFile, account);
  const stored = new Map((sourceSnapshot || []).map(row => [JSON.stringify([
    row.document_id, row.course_id, row.coursework_id, row.submission_id,
  ]), row]));
  const runId = randomUUID();
  for (const scope of scopes) {
    let googleCalls = 0;
    const start = performance.now();
    const scan = createClassroomCtaDiscovery({ get: async (path, params) => {
      if (!new RegExp('^courses/' + scope.courseId + '/courseWork(?:/[0-9]+(?:/studentSubmissions)?)?$').test(path)) {
        throw Error('CTA_SHADOW_PATH_OUT_OF_SCOPE');
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        googleCalls++;
        const response = await fetch('https://classroom.googleapis.com/v1/' + path + '?' + new URLSearchParams(params), {
          method: 'GET', headers, signal: AbortSignal.timeout(15_000),
        });
        if (response.ok) return response.json();
        const retryAfter = retryDelay(response.headers.get('Retry-After'));
        if ((response.status !== 429 && response.status < 500) || attempt === 2 || retryAfter > 30_000) {
          throw Error('CTA_CLASSROOM_GET_' + response.status);
        }
        await delay(Math.max(500 * 2 ** attempt, retryAfter));
      }
    } });
    try {
      const result = await scan(scope);
      const decisions = {};
      if (sourceSnapshot) {
        for (const row of result.sources) {
          const decision = assessSharedCta(row, stored.get(classroomSourceKey(row)), now);
          decisions[decision] = (decisions[decision] || 0) + 1;
        }
      }
      console.log(JSON.stringify({ runId, mode: 'read-only', classCode: scope.classCode, status: 'read',
        googleCalls, elapsedMs: Math.round(performance.now() - start), sharedSources: result.sources.length,
        sharedDigest: digest(result.sources.map(row => [classroomSourceKey(row), row.classroom.studentId])),
        speaking: result.speaking.map(({ assignmentCode, status, reason, submissions }) => ({
          assignmentCode, status, reason, copies: submissions?.length,
          digest: submissions ? digest(submissions.map(row => [row.id, row.userId, row.documentId])) : undefined,
        })), ...sourceSnapshot && { decisions }, docWrites: 0, sourceWrites: 0, queuePublishes: 0 }));
    } catch (error) {
      process.exitCode = 1;
      console.log(JSON.stringify({ runId, mode: 'read-only', classCode: scope.classCode, status: 'incomplete',
        googleCalls, error: error.code || error.message }));
    }
  }
}

main().catch(error => {
  console.error(JSON.stringify({ mode: 'read-only', status: 'failed', error: error.code || error.name }));
  process.exitCode = 1;
});
