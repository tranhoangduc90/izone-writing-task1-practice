const documentUrl = /^https:\/\/docs\.google\.com\/document\/d\/([A-Za-z0-9_-]{20,200})(?:\/|$)/;
const courseworkFields = 'nextPageToken,courseWork(id,courseId,title,state,updateTime)';
const submissionFields = 'nextPageToken,studentSubmissions(id,courseId,courseWorkId,userId,assignmentSubmission(attachments(driveFile(id,alternateLink))))';

function requireSource(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

const numericId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const versioned = value => typeof value === 'string'
  && /(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value));

export function classroomSourceKey({ documentId, classroom }) {
  return JSON.stringify([documentId, classroom.courseId, classroom.courseworkId, classroom.submissionId]);
}

export function assessSharedCta(source, stored, now) {
  if (!stored) return 'new';
  if (stored.student_id && stored.student_id !== source.classroom.studentId) return 'owner_conflict';
  const upgrade = stored.cta_pipeline_version < 2;
  if (upgrade && ['ready', 'review'].includes(stored.cta_state)) return 'historical_baseline';
  if (stored.cta_lease_until && new Date(stored.cta_lease_until).getTime() > now) {
    return stored.cta_execution_id || stored.cta_enqueued_at ? 'in_flight' : 'publish_existing_lease';
  }
  const changed = source.classroom.sourceVersion !== stored.source_version;
  if (!(upgrade || changed || ['pending', 'error'].includes(stored.cta_state))) return 'no_change';
  if (stored.cta_retry_at && new Date(stored.cta_retry_at).getTime() > now) return 'backoff';
  if (!upgrade && !changed && stored.cta_attempts >= 8) return 'retry_exhausted';
  return changed || upgrade ? 'version_pending' : 'retry_due';
}

// A scan is scoped to one Classroom course and one verified Google account.
// This reader has no state store, queue or product registrar.
export function createClassroomCtaDiscovery({ get, maxPages = 100 }) {
  requireSource(typeof get === 'function' && Number.isSafeInteger(maxPages) && maxPages > 0,
    'CLASSROOM_READER_CONFIGURATION_INVALID');

  async function* pages(path, collection, query, onPage) {
    const tokens = new Set();
    let token;
    for (let index = 0; index < maxPages; index++) {
      const page = await get(path, { pageSize: '100', ...query, ...(token ? { pageToken: token } : {}) });
      requireSource(page && (page[collection] === undefined || Array.isArray(page[collection])),
        'CLASSROOM_PAGE_INVALID');
      onPage(page);
      yield* page[collection] ?? [];
      token = page.nextPageToken;
      if (token === undefined || token === '') return;
      requireSource(typeof token === 'string' && !tokens.has(token), 'CLASSROOM_PAGE_TOKEN_INVALID');
      tokens.add(token);
    }
    requireSource(false, 'CLASSROOM_PAGE_LIMIT');
  }

  return async ({ courseId, classCode, classroomName, shared, speaking = [], courseWorkId }) => {
    requireSource(numericId(courseId) && typeof shared === 'boolean'
      && typeof classCode === 'string' && classCode.length > 0
      && (!courseWorkId || numericId(courseWorkId)), 'CLASSROOM_SCOPE_INVALID');
    const path = 'courses/' + courseId + '/courseWork';
    const selected = id => !courseWorkId || id === courseWorkId;
    const work = new Map();
    const scopes = new Map();
    const sources = new Map();
    const speakingResults = [];
    const counts = { courseworkPages: 0, courseworkReads: 0, submissionPages: 0 };

    for (const scope of speaking) {
      requireSource(scope?.courseId === courseId && numericId(scope.courseWorkId)
        && ['direct', 'docs_cta'].includes(scope.deliveryMode)
        && typeof scope.assignmentCode === 'string' && scope.assignmentCode.length > 0
        && !scopes.has(scope.courseWorkId), 'CLASSROOM_SPEAKING_SCOPE_INVALID');
      if (selected(scope.courseWorkId)) scopes.set(scope.courseWorkId, scope);
    }
    if (shared && !courseWorkId) {
      for await (const row of pages(path, 'courseWork', {
        courseWorkStates: 'PUBLISHED', orderBy: 'updateTime desc', fields: courseworkFields,
      }, () => counts.courseworkPages++)) {
        requireSource(row?.courseId === courseId && numericId(row.id)
          && row.state === 'PUBLISHED' && !work.has(row.id), 'CLASSROOM_COURSEWORK_INVALID');
        work.set(row.id, row);
      }
    }

    for (const id of new Set([...work.keys(), ...(shared && courseWorkId ? [courseWorkId] : []), ...scopes.keys()])) {
      let assignment = work.get(id);
      if (!assignment) {
        counts.courseworkReads++;
        assignment = await get(path + '/' + id, { fields: 'id,courseId,title,state,updateTime' });
      }
      requireSource(assignment?.id === id && assignment.courseId === courseId
        && ['PUBLISHED', 'DRAFT', 'DELETED'].includes(assignment.state), 'CLASSROOM_COURSEWORK_INVALID');
      const scope = scopes.get(id);
      const collectShared = shared && assignment.state === 'PUBLISHED';
      const collectSpeaking = scope?.deliveryMode === 'docs_cta' && assignment.state === 'PUBLISHED';
      let result;
      if (scope) {
        result = {
          courseId, courseWorkId: id, assignmentCode: scope.assignmentCode, classroomState: assignment.state,
          status: collectSpeaking ? 'snapshot' : assignment.state === 'PUBLISHED' ? 'direct' : 'not_published',
        };
        speakingResults.push(result);
      }
      if (!collectShared && !collectSpeaking) continue;
      if (collectShared) requireSource(versioned(assignment.updateTime), 'CLASSROOM_COURSEWORK_VERSION_INVALID');
      const speakingSubmissions = new Map();
      const speakingDocuments = new Set();
      const beforePages = counts.submissionPages;
      let speakingError;
      for await (const row of pages(path + '/' + id + '/studentSubmissions', 'studentSubmissions', {
        fields: submissionFields,
      }, page => {
        counts.submissionPages++;
        if (collectSpeaking && !Array.isArray(page.studentSubmissions)) {
          speakingError = 'CLASSROOM_SNAPSHOT_INCOMPLETE';
        }
      })) {
        requireSource(row?.courseId === courseId && row.courseWorkId === id
          && typeof row.id === 'string' && row.id && typeof row.userId === 'string' && row.userId,
        'CLASSROOM_SUBMISSION_IDENTITY');
        const files = (row.assignmentSubmission?.attachments || []).map(value => value.driveFile).filter(Boolean);
        if (collectShared) {
          for (const file of files) {
            const documentId = String(file.alternateLink || '').match(documentUrl)?.[1];
            if (!documentId) continue;
            requireSource(!file.id || file.id === documentId, 'CLASSROOM_ATTACHMENT_IDENTITY');
            const source = { documentId, classroom: {
              courseId, courseworkId: id, submissionId: row.id, studentId: row.userId, classCode, classroomName,
              homeworkTitle: String(assignment.title || '').slice(0, 300),
              sourceVersion: assignment.updateTime, sourceEventId: ['google', courseId, id, row.id, documentId].join(':'),
            } };
            const key = classroomSourceKey(source);
            const prior = sources.get(key);
            requireSource(!prior || prior.classroom.studentId === row.userId, 'CLASSROOM_SOURCE_OWNER_CONFLICT');
            sources.set(key, source);
          }
        }
        if (collectSpeaking && !speakingError) {
          const documents = files.map(file => file.id).filter(Boolean);
          const documentId = documents[0] ?? null;
          if (speakingSubmissions.has(row.id)) speakingError = 'CLASSROOM_SUBMISSION_DUPLICATE';
          else if (documents.length > 1) speakingError = 'CLASSROOM_COPY_AMBIGUOUS';
          else if (documentId && speakingDocuments.has(documentId)) speakingError = 'CLASSROOM_DOCUMENT_DUPLICATE';
          speakingSubmissions.set(row.id, { id: row.id, userId: row.userId, documentId });
          if (documentId) speakingDocuments.add(documentId);
        }
      }
      if (collectSpeaking) {
        // Preserve Speaking's prior one-page contract until its registrar supports larger scopes.
        if (counts.submissionPages - beforePages > 1 || speakingSubmissions.size > 100) {
          speakingError = 'CLASSROOM_SNAPSHOT_INCOMPLETE';
        }
        if (speakingError) Object.assign(result, { status: 'review', reason: speakingError });
        else result.submissions = [...speakingSubmissions.values()];
      }
    }
    return { courseId, sources: [...sources.values()], speaking: speakingResults, counts };
  };
}
