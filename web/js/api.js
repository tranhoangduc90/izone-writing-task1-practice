import { createRequestId } from "./core.js";

function endpoint(base, path) { return new URL(path.replace(/^\//, ""), base || window.location.href).toString(); }

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (response.status === 304) return { data: null, etag: response.headers.get("etag"), notModified: true };
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.message || `Yêu cầu thất bại (${response.status}).`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return { data, etag: response.headers.get("etag") };
}

function jsonOptions(method, body, headers = {}, keepalive = false) {
  return { method, headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body), keepalive };
}

/** API adapter: all backend-specific paths and request mappings belong in this file. */
export function createApi(base = "") {
  const root = endpoint(base, "api/v1/");
  return {
    roster: (slug) => fetchJson(endpoint(root, `activities/${encodeURIComponent(slug)}/roster`)),
    createSession: (activitySlug, classRef, studentRef) => fetchJson(endpoint(root, "sessions"), jsonOptions("POST", { activitySlug, classRef, studentRef, requestId: createRequestId() })),
    session: (sessionRef) => fetchJson(endpoint(root, `sessions/${encodeURIComponent(sessionRef)}`)),
    saveDraft: (sessionRef, progress, keepalive = false) => fetchJson(endpoint(root, `sessions/${encodeURIComponent(sessionRef)}/draft`), jsonOptions("PUT", {
      baseVersion: progress.revision,
      overview: progress.texts.overview,
      body1: progress.texts.body1,
      body2: progress.texts.body2,
      requestId: createRequestId(),
    }, progress.revision == null ? {} : { "if-match": String(progress.revision) }, keepalive)),
    checkSection: (sessionRef, section, snapshot, revision) => fetchJson(endpoint(root, `sessions/${encodeURIComponent(sessionRef)}/checks`), jsonOptions("POST", {
      section,
      requestId: createRequestId(),
      snapshot,
    }, revision == null ? {} : { "if-match": String(revision) })),
    attempt: (attemptRef, etag) => fetchJson(endpoint(root, `attempts/${encodeURIComponent(attemptRef)}`), { headers: etag ? { "if-none-match": etag } : {} }),
    retryAttempt: (attemptRef) => fetchJson(endpoint(root, `attempts/${encodeURIComponent(attemptRef)}/retry`), jsonOptions("POST", {})),
    beaconUrl: (sessionRef) => endpoint(root, `sessions/${encodeURIComponent(sessionRef)}/draft`),
  };
}
