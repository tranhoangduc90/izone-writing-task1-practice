const numericId = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const classCode = value => typeof value === 'string' && /^IC[0-9]+$/.test(value);
const maxSnapshotAge = 10 * 60_000;

function requireScope(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

export function readK67PortalSnapshot(response, now = Date.now()) {
  const data = response?.data;
  requireScope(response?.status === 'completed' && data?.rows_truncated !== true
    && data?.rows?.length === 1 && data.rows[0]?.length === 1 && data?.cols?.length === 1
    && data.cols[0]?.name === 'payload', 'RL67_PORTAL_RESPONSE_INCOMPLETE');
  let snapshot = data.rows[0][0];
  if (typeof snapshot === 'string') {
    try { snapshot = JSON.parse(snapshot); }
    catch { requireScope(false, 'RL67_PORTAL_RESPONSE_INCOMPLETE'); }
  }
  const observed = Date.parse(snapshot?.observedAt);
  requireScope(snapshot?.schemaVersion === 1 && snapshot.source === 'portal_erp_live'
    && typeof snapshot.observedAt === 'string' && snapshot.observedAt.endsWith('Z')
    && Number.isFinite(observed) && observed <= now && now - observed <= maxSnapshotAge, 'RL67_PORTAL_SOURCE_STALE');
  requireScope(Array.isArray(snapshot.classes) && snapshot.classes.length === snapshot.count, 'RL67_PORTAL_COUNT_MISMATCH');
  const ids = new Set(), codes = new Set();
  return {
    observedAt: snapshot.observedAt,
    classes: snapshot.classes.map(row => {
      const erpClassId = String(row.erpClassId);
      requireScope(numericId(erpClassId) && !ids.has(erpClassId) && classCode(row.classCode) && !codes.has(row.classCode)
        && String(row.courseId) === '5' && row.courseShortName === '67' && row.status === 'on_going'
        && row.classDeletedAt === null && row.courseDeletedAt === null, 'RL67_PORTAL_CLASS_INVALID');
      ids.add(erpClassId);
      codes.add(row.classCode);
      return { erpClassId, classCode: row.classCode };
    }),
  };
}

export function selectK67ClassroomMappings(snapshot, rows) {
  requireScope(Array.isArray(rows), 'RL67_MAPPING_RESPONSE_INVALID');
  const scoped = new Map(snapshot.classes.map(c => [c.erpClassId, c]));
  const approved = new Map();
  const usedCourses = new Set();
  for (const row of rows) {
    requireScope(scoped.has(row?.erpClassId), 'RL67_MAPPING_FOREIGN_CLASS');
    if (row.status !== 'approved') continue;
    requireScope(numericId(row.courseId) && Number(row.approvedCourseReferences) === 1
      && !usedCourses.has(row.courseId) && !approved.has(row.erpClassId), 'RL67_MAPPING_AMBIGUOUS');
    approved.set(row.erpClassId, row.courseId);
    usedCourses.add(row.courseId);
  }
  return {
    mapped: snapshot.classes.filter(c => approved.has(c.erpClassId))
      .map(c => ({ ...c, courseId: approved.get(c.erpClassId), shared: true })),
    missing: snapshot.classes.filter(c => !approved.has(c.erpClassId))
      .map(c => ({ ...c, reason: 'classroom_mapping_pending' })),
  };
}

// The mapping verifies the relationship. Google verifies access and active state.
// Fetch by approved ID. A single unavailable course cannot hide the other courses.
export function createK67ClassroomScope({ getPortal, getMappings, getClassroomCourse, clock = Date.now }) {
  return async ({ classCode: filter } = {}) => {
    requireScope(filter === undefined || classCode(filter), 'CTA_MANUAL_CLASS_INVALID');
    const snapshot = readK67PortalSnapshot(await getPortal(), clock());
    requireScope(!filter || snapshot.classes.some(row => row.classCode === filter), 'CTA_MANUAL_CLASS_OUTSIDE_SCOPE');
    const selected = { ...snapshot, classes: snapshot.classes.filter(row => !filter || row.classCode === filter) };
    const { mapped, missing } = selectK67ClassroomMappings(selected, await getMappings(selected.classes));
    const courses = [];
    for (const row of mapped) {
      try {
        const classroom = await getClassroomCourse(row.courseId);
        requireScope(classroom?.id === row.courseId && typeof classroom.name === 'string',
          'RL67_CLASSROOM_RESPONSE_INVALID');
        if (classroom.courseState === 'ACTIVE') courses.push({ ...row, classroomName: classroom.name });
        else missing.push({ ...row, reason: 'classroom_inactive' });
      } catch (error) {
        const code = /^[A-Z0-9_]{1,100}$/.test(error?.code || '') ? error.code : 'RL67_CLASSROOM_READ_FAILED';
        missing.push({ ...row, reason: 'classroom_unavailable', errorCode: code });
      }
    }
    return { observedAt: snapshot.observedAt, portalClasses: snapshot.classes.length, courses, missing,
      status: missing.length ? 'partial' : 'done' };
  };
}
