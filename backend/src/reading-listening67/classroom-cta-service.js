import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { createClassroomCtaDiscovery } from './classroom-cta-discovery.js';

const numericId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const scopeKey = value => JSON.stringify([value.classCode, value.courseId]);
const maxBody = 32 * 1024;

function parseScope(input, allowed) {
  if (!input || !allowed.has(scopeKey(input)) || !Array.isArray(input.speaking)
      || input.speaking.length > 200 || typeof input.classroomName !== 'string'
      || !input.classroomName.trim() || input.classroomName.length > 200) return null;
  for (const scope of input.speaking) {
    if (scope?.courseId !== input.courseId || scope.classCode !== input.classCode
        || !numericId(scope.courseWorkId) || !/^[A-Za-z0-9_-]{1,80}$/.test(scope.assignmentCode || '')
        || !['direct', 'docs_cta'].includes(scope.deliveryMode)) return null;
  }
  return { courseId: input.courseId, classCode: input.classCode, classroomName: input.classroomName,
    shared: true, speaking: input.speaking };
}

export function createClassroomCtaServer({ token, classes, get, log = () => {} }) {
  if (typeof token !== 'string' || token.length < 32 || !Array.isArray(classes) || !classes.length
      || classes.some(scope => !numericId(scope?.courseId) || !/^IC[0-9]+$/.test(scope.classCode || ''))) {
    throw new Error('CTA_SCANNER_CONFIG_INVALID');
  }
  const expected = Buffer.from('Bearer ' + token);
  const allowed = new Set(classes.map(scopeKey));
  const discover = createClassroomCtaDiscovery({ get });
  let running = false;
  return createServer(async (req, res) => {
    const send = (status, data) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(data));
    };
    const actual = Buffer.from(req.headers.authorization || '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return send(401, { ok: false, error: 'CTA_SCANNER_UNAUTHORIZED' });
    }
    if (req.method === 'GET' && req.url === '/ready') return send(200, { ok: true, ready: true });
    if (req.method !== 'POST' || req.url !== '/scan') return send(404, { ok: false, error: 'CTA_SCANNER_ROUTE_NOT_FOUND' });
    let input, bodySize = 0;
    const body = [];
    try {
      for await (const chunk of req) {
        bodySize += chunk.length;
        if (bodySize > maxBody) break;
        body.push(chunk);
      }
      if (bodySize > maxBody) return send(413, { ok: false, error: 'CTA_SCANNER_BODY_TOO_LARGE' });
      input = parseScope(JSON.parse(Buffer.concat(body).toString('utf8')), allowed);
    } catch {
      return send(400, { ok: false, error: 'CTA_SCANNER_BODY_INVALID' });
    }
    if (!input) return send(403, { ok: false, error: 'CTA_SCANNER_SCOPE_REJECTED' });
    if (running) return send(409, { ok: false, error: 'CTA_SCANNER_BUSY' });
    running = true;
    try {
      const result = await discover(input);
      log({ classCode: input.classCode, status: 'read', sources: result.sources.length,
        speaking: result.speaking.length, ...result.counts });
      return send(200, { ok: true, ...result });
    } catch (error) {
      const code = /^[A-Z0-9_]+$/.test(error.code || '') ? error.code : 'CTA_SCANNER_READ_FAILED';
      log({ classCode: input.classCode, status: 'error', code });
      return send(502, { ok: false, error: code });
    } finally {
      running = false;
    }
  });
}
