import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

const slotMs = 15 * 60_000;
const codeOf = error => /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'CTA_RUNTIME_FAILED';

export function createK67CtaHttp({ runtime, manualDocuments, manualPage, token, ready, log = () => {} }) {
  if (typeof token !== 'string' || token.length < 32) throw Error('CTA_RUNTIME_TOKEN_INVALID');
  const expected = Buffer.from('Bearer ' + token);
  const server = createServer(async (req, res) => {
    const send = (status, payload) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    const pageAction = manualPage && manualDocuments && /^\/operator\/cta\/(submit|status)$/.exec(req.url)?.[1];
    if (pageAction) {
      res.setHeader('Vary', 'Origin');
      if (req.headers.origin !== manualPage.origin) return send(403, { ok: false, error: 'CTA_OPERATOR_ORIGIN_DENIED' });
      res.setHeader('Access-Control-Allow-Origin', manualPage.origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'POST',
          'Access-Control-Allow-Headers': 'Content-Type, X-Izone-Csrf', 'Cache-Control': 'no-store' });
        return res.end();
      }
      if (req.method !== 'POST' || req.headers['x-izone-csrf'] !== '1') {
        return send(403, { ok: false, error: 'CTA_OPERATOR_REQUEST_DENIED' });
      }
      try {
        await manualPage.authorize(req);
      } catch (error) {
        const status = [401, 403].includes(error?.status) ? error.status : 503;
        const code = status === 401 ? 'CTA_OPERATOR_LOGIN_REQUIRED' : status === 403 ? 'CTA_OPERATOR_FORBIDDEN' : 'CTA_OPERATOR_AUTH_UNAVAILABLE';
        log({ stage: 'manual_page_auth', action: pageAction, errorCode: code });
        return send(status, { ok: false, error: code });
      }
    } else {
      const supplied = Buffer.from(String(req.headers.authorization || ''));
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        return send(401, { ok: false, error: 'CTA_RUNTIME_UNAUTHORIZED' });
      }
    }
    if (req.method === 'GET' && req.url === '/ready') {
      try {
        if (await ready() === true) return send(200, { ok: true, ready: true });
      } catch (error) { log({ stage: 'ready', errorCode: codeOf(error) }); }
      return send(503, { ok: false, ready: false });
    }
    const documentAction = pageAction || (manualDocuments && /^\/manual-docs\/(submit|status)$/.exec(req.url)?.[1]);
    if (req.method !== 'POST' || (req.url !== '/manual' && !documentAction)) {
      return send(404, { ok: false, error: 'CTA_RUNTIME_ROUTE_NOT_FOUND' });
    }
    let input;
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > (documentAction ? 8192 : 2048)) return send(413, { ok: false, error: 'CTA_RUNTIME_BODY_TOO_LARGE' });
        chunks.push(chunk);
      }
      input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (documentAction) {
        if (!input || Array.isArray(input) || Object.keys(input).length !== 1 || !Array.isArray(input.docs)) {
          return send(400, { ok: false, error: 'CTA_MANUAL_BATCH_INVALID' });
        }
      } else if (!input || Array.isArray(input) || Object.keys(input).some(key => !['classCode', 'courseWorkId'].includes(key))
        || typeof input.classCode !== 'string' || (input.courseWorkId !== undefined && typeof input.courseWorkId !== 'string')) {
        return send(400, { ok: false, error: 'CTA_MANUAL_SCOPE_INVALID' });
      }
    } catch {
      return send(400, { ok: false, error: 'CTA_RUNTIME_BODY_INVALID' });
    }
    try {
      if (documentAction) {
        const result = await manualDocuments(documentAction, input.docs);
        if (pageAction) log({ stage: 'manual_page', action: pageAction, count: result.results.length });
        return send(200, result);
      }
      const result = await runtime.manual(input);
      const statuses = result.results.map(row => row.status);
      if (statuses.length && statuses.every(status => status === 'legacy_owner')) {
        return send(409, { ok: false, error: 'CTA_SCOPE_NOT_OWNED', ...result });
      }
      return send(result.status === 'done' ? 200 : 207, { ok: result.status === 'done', ...result });
    } catch (error) {
      const code = codeOf(error);
      const invalid = ['CTA_MANUAL_BATCH_INVALID', 'CTA_MANUAL_SCOPE_INVALID', 'CTA_MANUAL_CLASS_INVALID',
        'CTA_MANUAL_CLASS_OUTSIDE_SCOPE'].includes(code);
      log({ stage: 'manual', classCode: input.classCode, errorCode: code });
      return send(invalid ? 400 : 503, { ok: false, error: code });
    }
  });
  server.requestTimeout = 5_000;
  server.headersTimeout = 5_000;
  return server;
}

export function createK67CtaWorkSignal() {
  let pending = new AbortController();
  return {
    current: () => pending.signal,
    notify() {
      const previous = pending;
      pending = new AbortController();
      previous.abort();
    },
  };
}

export function startK67CtaLoops({ runtime, workSignal = createK67CtaWorkSignal(), log = () => {}, clock = Date.now }) {
  const controller = new AbortController();
  const { signal } = controller;
  const sleep = (ms, until = signal) => delay(ms, undefined, { signal: until }).catch(error => {
    if (error.name !== 'AbortError') throw error;
  });
  async function ticker() {
    while (!signal.aborted) {
      try { await runtime.tick(); }
      catch (error) { log({ stage: 'schedule', errorCode: codeOf(error) }); }
      await sleep(slotMs - clock() % slotMs);
    }
  }
  async function writer() {
    while (!signal.aborted) {
      // Capture before the claim so work committed during an empty claim wakes this waiter too.
      const untilNewWork = AbortSignal.any([signal, workSignal.current()]);
      let worked;
      try { worked = (await runtime.workOnce()).status; }
      catch (error) { log({ stage: 'worker', errorCode: codeOf(error) }); }
      if (worked === 'idle') await sleep(10_000, untilNewWork);
      else if (worked === undefined) await sleep(10_000);
      else if (worked === 'unknown' || worked === 'busy') await sleep(1_000);
    }
  }
  const tasks = [ticker(), writer()];
  return async () => {
    controller.abort();
    await Promise.all(tasks);
  };
}
