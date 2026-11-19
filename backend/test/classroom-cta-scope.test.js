import assert from 'node:assert/strict';
import test from 'node:test';
import { createK67ClassroomScope, readK67PortalSnapshot, selectK67ClassroomMappings } from '../src/reading-listening67/classroom-cta-scope.js';

const observedAt = '2026-11-19T07:10:00Z';
const now = Date.parse(observedAt) + 1000;
const active = (erpClassId, classCode) => ({
  erpClassId, classCode, courseShortName: '67', courseId: 5, status: 'on_going',
  classDeletedAt: null, courseDeletedAt: null,
});
const portal = (classes, props = {}) => ({
  status: 'completed', data: { cols: [{ name: 'payload' }], rows: [[JSON.stringify({
    schemaVersion: 1, source: 'portal_erp_live', observedAt, classes, count: classes.length, ...props,
  })]] },
});
const mapping = (erpClassId, courseId) => ({ erpClassId, courseId, status: 'approved', approvedCourseReferences: 1 });

test('active Portal classes are joined by approved ERP ID before using targeted Classroom reads', async () => {
  const rows = [active('60', 'IC2340'), active('61', 'IC2353'), active('62', 'IC2363')];
  const calls = [];
  const list = createK67ClassroomScope({
    getPortal: async () => portal(rows),
    async getMappings(classes) {
      calls.push(classes.map(s => s.erpClassId));
      return [mapping('61', '100'), mapping('60', '200')].filter(m => classes.some(c => c.erpClassId === m.erpClassId));
    },
    async getClassroomCourse(id) {
      calls.push(id);
      if (id === '200') throw Object.assign(new Error('not available'), { code: 'CTA_CLASSROOM_GET_403' });
      return { id, courseState: 'ACTIVE', name: 'Class 100' };
    },
    clock: () => now,
  });
  const all = await list();
  assert.equal(all.status, 'partial');
  assert.deepEqual(all.courses.map(c => c.classCode), ['IC2353']);
  assert.deepEqual(all.missing.map(({ classCode, reason }) => [classCode, reason]), [
    ['IC2363', 'classroom_mapping_pending'], ['IC2340', 'classroom_unavailable'],
  ]);
  assert.deepEqual(calls, [['60', '61', '62'], '200', '100']);
  assert.equal((await list({ classCode: 'IC2353' })).courses[0].courseId, '100');
  assert.deepEqual(calls.slice(-2), [['61'], '100']);
  await assert.rejects(list({ classCode: 'IC9999' }), { code: 'CTA_MANUAL_CLASS_OUTSIDE_SCOPE' });
});

test('stale, future, malformed and ambiguous inputs fail instead of returning a smaller roster', () => {
  const classes = [active('60', 'IC2353'), active('61', 'IC2340')];
  assert.throws(() => readK67PortalSnapshot(portal(classes), now + 600000), { code: 'RL67_PORTAL_SOURCE_STALE' });
  assert.throws(() => readK67PortalSnapshot(portal(classes), now - 2000), { code: 'RL67_PORTAL_SOURCE_STALE' });
  assert.throws(() => readK67PortalSnapshot(portal(classes, { count: 1 }), now), { code: 'RL67_PORTAL_COUNT_MISMATCH' });
  assert.throws(() => readK67PortalSnapshot(portal([classes[0], active('61', 'IC2353')]), now), { code: 'RL67_PORTAL_CLASS_INVALID' });
  const snapshot = readK67PortalSnapshot(portal(classes), now);
  assert.throws(() => selectK67ClassroomMappings(snapshot, [mapping('60', '100'), mapping('61', '100')]),
    { code: 'RL67_MAPPING_AMBIGUOUS' });
  assert.throws(() => selectK67ClassroomMappings(snapshot, [mapping('62', '100')]), { code: 'RL67_MAPPING_FOREIGN_CLASS' });
});
