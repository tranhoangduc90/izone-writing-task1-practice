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
    registerProvisional: (activitySlug, classRef, displayName, pin, duplicateConfirmed = false, requestId = createRequestId()) => fetchJson(endpoint(root, `activities/${encodeURIComponent(activitySlug)}/provisional-students`), jsonOptions("POST", { classRef, displayName, pin, duplicateConfirmed, requestId })),
    createSession: (activitySlug, classRef, studentRef, accessCode) => fetchJson(endpoint(root, "sessions"), jsonOptions("POST", { activitySlug, classRef, studentRef, ...(accessCode ? { accessCode } : {}), requestId: createRequestId() })),
    session: (sessionRef) => fetchJson(endpoint(root, `sessions/${encodeURIComponent(sessionRef)}`)),
    draftResult: (sessionRef) => fetchJson(endpoint(root, `sessions/${encodeURIComponent(sessionRef)}/draft-result`)),
    saveDraft: (sessionRef, progress, keepalive = false) => fetchJson(endpoint(root, `sessions/${encodeURIComponent(sessionRef)}/draft`), jsonOptions("PUT", {
      baseVersion: progress.revision,
      overview: progress.texts.overview,
      body1: progress.texts.body1,
      body2: progress.texts.body2,
      draft1: progress.texts.draft1,
      draft2: progress.texts.draft2,
      draft2Unlocked: progress.draft2Unlocked,
      requestId: createRequestId(),
    }, progress.revision == null ? {} : { "if-match": String(progress.revision) }, keepalive)),
    checkSection: (sessionRef, section, snapshot, revision) => fetchJson(endpoint(root, `sessions/${encodeURIComponent(sessionRef)}/checks`), jsonOptions("POST", {
      section,
      requestId: createRequestId(),
      snapshot,
    }, revision == null ? {} : { "if-match": String(revision) })),
    attempt: (attemptRef, etag) => fetchJson(endpoint(root, `attempts/${encodeURIComponent(attemptRef)}`), { headers: etag ? { "if-none-match": etag } : {} }),
    retryAttempt: (attemptRef) => fetchJson(endpoint(root, `attempts/${encodeURIComponent(attemptRef)}/retry`), jsonOptions("POST", {})),
    teacherComments: (sessionRef, etag) => fetchJson(endpoint(root, `sessions/${encodeURIComponent(sessionRef)}/teacher-comments`), { headers: etag ? { "if-none-match": etag } : {} }),
    replyTeacherComment: (sessionRef, threadRef, body, requestId = createRequestId()) => fetchJson(endpoint(root, `sessions/${encodeURIComponent(sessionRef)}/teacher-comments/${encodeURIComponent(threadRef)}/replies`), jsonOptions("POST", { body, requestId })),
    publishLive: (sessionRef) => fetchJson(endpoint(root, `sessions/${encodeURIComponent(sessionRef)}/live`), jsonOptions("PUT", {}, {}, true)),
    beaconUrl: (sessionRef) => endpoint(root, `sessions/${encodeURIComponent(sessionRef)}/draft`),
  };
}

export function createLessonApi(base = "") {
  const root = endpoint(base, "api/v1/");
  return {
    roster: (slug) => fetchJson(endpoint(root, `activities/${encodeURIComponent(slug)}/roster`)),
    registerProvisional: (activitySlug, classRef, displayName, pin, duplicateConfirmed = false, requestId = createRequestId()) => fetchJson(endpoint(root, `activities/${encodeURIComponent(activitySlug)}/provisional-students`), jsonOptions("POST", { classRef, displayName, pin, duplicateConfirmed, requestId })),
    createSession: (activitySlug, classRef, studentRef, accessCode) => fetchJson(endpoint(root, "lesson-sessions"), jsonOptions("POST", {
      activitySlug,
      classRef,
      studentRef,
      ...(accessCode ? { accessCode } : {}),
    })),
    session: (sessionRef) => fetchJson(endpoint(root, `lesson-sessions/${encodeURIComponent(sessionRef)}`)),
    draftResult: (sessionRef) => fetchJson(endpoint(root, `lesson-sessions/${encodeURIComponent(sessionRef)}/draft-result`)),
    saveResponses: (sessionRef, progress, keepalive = false) => fetchJson(endpoint(root, `lesson-sessions/${encodeURIComponent(sessionRef)}/responses`), jsonOptions("PUT", {
      baseVersion: progress.revision,
      responses: progress.responses,
      requestId: createRequestId(),
    }, progress.revision == null ? {} : { "if-match": String(progress.revision) }, keepalive)),
    checkSection: (sessionRef, section) => fetchJson(endpoint(root, `lesson-sessions/${encodeURIComponent(sessionRef)}/checks`), jsonOptions("POST", {
      section,
      requestId: createRequestId(),
    })),
    publishLive: (sessionRef, activeField) => fetchJson(endpoint(root, `lesson-sessions/${encodeURIComponent(sessionRef)}/live`), jsonOptions("PUT", {
      activeField: activeField || null,
    }, {}, true)),
    attempt: (attemptRef, etag) => fetchJson(endpoint(root, `attempts/${encodeURIComponent(attemptRef)}`), { headers: etag ? { "if-none-match": etag } : {} }),
    retryAttempt: (attemptRef) => fetchJson(endpoint(root, `attempts/${encodeURIComponent(attemptRef)}/retry`), jsonOptions("POST", {})),
    teacherComments: (sessionRef, etag) => fetchJson(endpoint(root, `sessions/${encodeURIComponent(sessionRef)}/teacher-comments`), { headers: etag ? { "if-none-match": etag } : {} }),
    replyTeacherComment: (sessionRef, threadRef, body, requestId = createRequestId()) => fetchJson(endpoint(root, `sessions/${encodeURIComponent(sessionRef)}/teacher-comments/${encodeURIComponent(threadRef)}/replies`), jsonOptions("POST", { body, requestId })),
    beaconUrl: (sessionRef) => endpoint(root, `lesson-sessions/${encodeURIComponent(sessionRef)}/responses`),
  };
}

export function createTeacherApi(base = "", getToken = () => "") {
  const root = endpoint(base, "api/v1/");
  const authorized = () => ({ authorization: `Bearer ${getToken()}` });
  return {
    liveActivity: (slug, classRef = "") => {
      const url = new URL(endpoint(root, `admin/live/activities/${encodeURIComponent(slug)}`));
      if (classRef) url.searchParams.set("classRef", classRef);
      return fetchJson(url, { headers: authorized() });
    },
    liveSession: (sessionRef) => fetchJson(endpoint(root, `admin/live/sessions/${encodeURIComponent(sessionRef)}`), { headers: authorized() }),
    draftResult: (sessionRef) => fetchJson(endpoint(root, `sessions/${encodeURIComponent(sessionRef)}/draft-result`), { headers: authorized() }),
    provisionalStudents: (slug, classRef = "") => { const url = new URL(endpoint(root, `admin/activities/${encodeURIComponent(slug)}/provisional-students`)); if (classRef) url.searchParams.set("classRef", classRef); return fetchJson(url, { headers: authorized() }); },
    searchOfficialStudents: (query, excludeStudentRef = "") => { const url = new URL(endpoint(root, "admin/official-students/search")); url.searchParams.set("q", query); if (excludeStudentRef) url.searchParams.set("excludeStudentRef", excludeStudentRef); return fetchJson(url, { headers: authorized() }); },
    resetProvisionalCode: (studentRef) => fetchJson(endpoint(root, `admin/provisional-students/${encodeURIComponent(studentRef)}/reset-code`), jsonOptions("POST", {}, authorized())),
    reconcileProvisional: (studentRef, officialStudentRef) => fetchJson(endpoint(root, `admin/provisional-students/${encodeURIComponent(studentRef)}/reconcile`), jsonOptions("POST", { officialStudentRef }, authorized())),
    deleteProvisional: (studentRef) => fetchJson(endpoint(root, `admin/provisional-students/${encodeURIComponent(studentRef)}/delete`), jsonOptions("POST", {}, authorized())),
    exportProgress: async (slug, classRef = "") => { const url = new URL(endpoint(root, `admin/activities/${encodeURIComponent(slug)}/export.csv`)); if (classRef) url.searchParams.set("classRef", classRef); const response = await fetch(url, { headers: authorized() }); if (!response.ok) throw new Error(`Không thể tải CSV (${response.status}).`); return response.blob(); },
    retryFailedAttempt: (attemptRef) => fetchJson(endpoint(root, `admin/attempts/${encodeURIComponent(attemptRef)}/retry`), jsonOptions("POST", {}, authorized())),
    teacherComments: (sessionRef, etag) => fetchJson(endpoint(root, `admin/live/sessions/${encodeURIComponent(sessionRef)}/teacher-comments`), { headers: { ...authorized(), ...(etag ? { "if-none-match": etag } : {}) } }),
    createTeacherComment: (sessionRef, payload) => fetchJson(endpoint(root, `admin/live/sessions/${encodeURIComponent(sessionRef)}/teacher-comments`), jsonOptions("POST", payload, authorized())),
    replyTeacherComment: (threadRef, body, requestId = createRequestId()) => fetchJson(endpoint(root, `admin/teacher-comments/${encodeURIComponent(threadRef)}/replies`), jsonOptions("POST", { body, requestId }, authorized())),
    setTeacherCommentStatus: (threadRef, status, requestId = createRequestId()) => fetchJson(endpoint(root, `admin/teacher-comments/${encodeURIComponent(threadRef)}/status`), jsonOptions("POST", { status, requestId }, authorized())),
    reopenSection: (sessionRef, section, reason) => fetchJson(endpoint(root, `admin/lesson-sessions/${encodeURIComponent(sessionRef)}/sections/${encodeURIComponent(section)}/reopen`), jsonOptions("POST", { reason }, authorized())),
  };
}
