import { readFileSync } from 'node:fs';
import { randomUUID, createHash } from 'node:crypto';
import { assessSharedCta, classroomSourceKey, createClassroomCtaDiscovery } from '../src/reading-listening67/classroom-cta-discovery.js';

import { createClassroomReadOnlyClient } from '../src/reading-listening67/classroom-cta-google.js';

const digest = rows => createHash('sha256').update(JSON.stringify(rows.map(row => JSON.stringify(row)).sort())).digest('hex');

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

  const stored = new Map((sourceSnapshot || []).map(row => [JSON.stringify([
    row.document_id, row.course_id, row.coursework_id, row.submission_id,
  ]), row]));
  const runId = randomUUID();
  for (const scope of scopes) {
    let googleCalls = 0;
    const start = performance.now();
    const scan = createClassroomCtaDiscovery({ get: createClassroomReadOnlyClient({ file: oauthFile, account, onRequest: () => googleCalls++ }) });
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
