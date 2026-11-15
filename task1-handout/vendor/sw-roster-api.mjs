import { normalizeSwRosterName } from './sw-roster-registry.mjs';

const key = (classRef, studentRef) => `${classRef}:${studentRef}`;

function error(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

function caught(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

export function createSwRosterApi({
  z, product, registry, projection, allowedOrigins, allowAdds = false,
  log = event => console.info(JSON.stringify(event)), supportsActivity = () => true,
}) {
  const uuid = z.uuid();
  const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{1,79}$/u);
  const addInput = z.object({
    classRef: uuid,
    displayName: z.string().max(150),
    requestId: uuid,
    duplicateConfirmed: z.boolean().optional(),
  }).strict();
  const retryInput = z.object({ classRef: uuid, studentRef: uuid }).strict();
  let sweep;
  const activitySyncs = new Map();
  function requireOrigin(req, _res, next) {
    if (allowedOrigins.has(req.get('origin')) && req.get('x-izone-csrf') === '1') return next();
    next(error(403, 'SW_ROSTER_ORIGIN_DENIED', 'Trang này không được phép gửi thao tác thêm học viên.'));
  }

  function emit(event, fields) {
    log({ event, product, ...fields });
  }

  async function scopeFor(activitySlug, classRef) {
    const scope = supportsActivity(activitySlug) && await projection.resolveScope(activitySlug, classRef);
    if (!scope) throw error(404, 'SW_ROSTER_SCOPE_UNAVAILABLE', 'Bài hoặc lớp SW này chưa được mở.');
    return scope;
  }

  async function deliver(scope, member, projected) {
    if (!member.active) {
      if (projected?.active) await projection.deactivate(scope, member.studentRef);
      return 'inactive';
    }
    if (!projected?.active) await projection.apply(scope, member);
    const readback = projected?.active || (await projection.managedStudent(scope.classRef, member.studentRef))?.open;
    if (!readback) throw error(503, 'SW_ROSTER_READBACK_PENDING', 'Chưa xác nhận được danh sách ở bài này.');
    return 'ready';
  }

  async function syncScopes(scopes, report) {
    const classes = [...new Set(scopes.map(scope => scope.erpClassId))];
    const [members, projected] = await Promise.all([
      registry.listForClasses(classes), projection.listProjected(scopes),
    ]);
    const byKey = new Map(projected.map(row => [key(row.classRef, row.studentRef), row]));
    const byClass = new Map(classes.map(id => [id, scopes.filter(scope => scope.erpClassId === id)]));
    for (const member of members) {
      const targets = [];
      for (const scope of byClass.get(member.erpClassId)) {
        const target = { activitySlug: scope.activitySlug, classRef: scope.classRef, title: scope.title };
        try {
          target.status = await deliver(scope, member, byKey.get(key(scope.classRef, member.studentRef)));
        } catch (err) {
          target.status = 'pending';
          target.error = err.code || 'SW_ROSTER_TARGET_FAILED';
        }
        targets.push(target);
      }
      if (report && await registry.recordDelivery(member.studentRef, product, targets)) {
        emit('sw_roster_delivery', { erpClassId: member.erpClassId, studentRef: member.studentRef, targets });
      }
    }
  }

  function runSweep() {
    if (!sweep) sweep = projection.listScopes()
      .then(scopes => syncScopes(scopes.filter(scope => supportsActivity(scope.activitySlug)), true))
      .finally(() => { sweep = null; });
    return sweep;
  }

  function syncActivity(activitySlug) {
    if (!supportsActivity(activitySlug)) return Promise.resolve();
    if (!activitySyncs.has(activitySlug)) {
      activitySyncs.set(activitySlug, projection.listScopes(null, activitySlug)
        .then(scopes => syncScopes(scopes, false))
        .catch(err => emit('sw_roster_activity_sync_failed', { activitySlug, code: err.code || 'SYNC_FAILED' }))
        .finally(() => activitySyncs.delete(activitySlug)));
    }
    return activitySyncs.get(activitySlug);
  }

  async function enrichRoster(activitySlug, roster) {
    if (!supportsActivity(activitySlug)) return roster;
    const scopes = await projection.listScopes(null, activitySlug);
    const projected = await projection.listProjected(scopes);
    const managed = new Set(projected.filter(row => row.active).map(row => key(row.classRef, row.studentRef)));
    return {
      ...roster,
      classes: roster.classes.map(group => ({
        ...group,
        students: group.students.map(student => managed.has(key(group.classRef, student.studentRef))
          ? { ...student, classManaged: true }
          : student),
      })),
    };
  }

  async function requireLearner(member, opening = false) {
    const allowed = member.open && Boolean(await registry.findActive(member));
    if (opening) {
      emit('sw_roster_open_access', { erpClassId: member.erpClassId,
        studentRef: member.studentRef, allowed });
    }
    if (!allowed) {
      throw error(401, 'SW_ROSTER_ACCESS_REQUIRED', 'Hồ sơ này hiện chưa có quyền làm bài trong lớp.');
    }
  }

  function install(app, { teacher, assertTeacher, getRoster, writeLimit, disableStudentOpens = false }) {
    const activity = '/api/v1/admin/activities/:slug/class-members';
    const opens = ['/api/v1/sessions', '/api/v1/lesson-sessions', '/api/v1/lesson9/sessions'];
    const sessions = opens.map(path => `${path}/:swRef`);

    async function authorized(req, classRef) {
      const activitySlug = slug.parse(req.params.slug);
      await assertTeacher(req, { activitySlug, classRef });
      return scopeFor(activitySlug, classRef);
    }

    async function save(req, res, retry = false) {
      if (!allowAdds && !retry) {
        throw error(503, 'SW_ROSTER_ADD_UNAVAILABLE', 'Thao tác thêm học viên đang tạm dừng.');
      }
      const input = (retry ? retryInput : addInput).parse(req.body);
      const scope = await authorized(req, input.classRef);
      const actor = req.reviewer.email.trim().toLowerCase();
      let result;
      if (!retry) {
        const { key: nameKey } = normalizeSwRosterName(input.displayName);
        const { classes } = await getRoster(scope.activitySlug);
        const existingName = classes.find(group => group.classRef === scope.classRef)?.students
          .some(student => student.displayName.normalize('NFC').trim().replace(/\s+/gu, ' ')
            .toLocaleLowerCase('vi') === nameKey);
        result = await registry.add({ ...input, actor, scope, existingName });
      } else {
        const member = await registry.findActive({ ...scope, studentRef: input.studentRef });
        if (!member) throw error(404, 'SW_ROSTER_MEMBER_NOT_FOUND', 'Không tìm thấy hồ sơ còn quyền học trong lớp.');
        result = { member, idempotent: true };
      }

      const fields = { requestId: input.requestId, erpClassId: scope.erpClassId,
        activitySlug: scope.activitySlug, classRef: scope.classRef, studentRef: result.member.studentRef };
      const began = Date.now();
      try {
        await deliver(scope, result.member);
      } catch (err) {
        emit('sw_roster_save', { ...fields, state: 'current_pending', code: err.code || 'TARGET_FAILED',
          elapsedMs: Date.now() - began });
        return res.status(202).json({ ok: true, member: result.member, state: 'current_pending' });
      }
      emit('sw_roster_save', { ...fields, state: 'ready', elapsedMs: Date.now() - began });
      res.status(result.idempotent ? 200 : 201).json({ ok: true, ...result, state: 'ready' });
      void runSweep().catch(err => emit('sw_roster_sweep_failed', { code: err.code || 'SYNC_FAILED' }));
    }

    app.get(activity, teacher, caught(async (req, res) => {
      const scope = await authorized(req, uuid.parse(req.query.classRef));
      const [members, delivery] = await Promise.all([
        registry.listActive(scope.erpClassId), registry.listDelivery(scope.erpClassId),
      ]);
      const projected = await projection.listProjected([scope]);
      const ready = new Set(projected.filter(row => row.active).map(row => row.studentRef));
      res.json({ ok: true, canAdd: allowAdds, members: members.map(member => ({
        ...member,
        currentReady: ready.has(member.studentRef),
        delivery: delivery.filter(item => item.studentRef === member.studentRef),
      })) });
    }));
    app.post(activity, requireOrigin, writeLimit, teacher, caught((req, res) => save(req, res)));
    app.post(`${activity}/retry`, requireOrigin, writeLimit, teacher, caught((req, res) => save(req, res, true)));

    app.post(opens, caught(async (req, _res, next) => {
      if (disableStudentOpens) throw error(503, 'SW_ROSTER_CANARY_READ_ONLY', 'Phiên kiểm chỉ đọc.');
      const { classRef, studentRef } = req.body || {};
      if (uuid.safeParse(classRef).success && uuid.safeParse(studentRef).success) {
        const member = await projection.managedStudent(classRef, studentRef);
        if (member) await requireLearner(member, true);
      }
      next();
    }));
    function ownerGuard(kind) {
      return caught(async (req, res, next) => {
        if (!uuid.safeParse(req.params.swRef).success) return next();
        const member = await projection.ownerOf(kind, req.params.swRef);
        if (!member) return next();
        try {
          await requireLearner(member);
        } catch (err) {
          if (err.code !== 'SW_ROSTER_ACCESS_REQUIRED' || kind !== 'session' ||
              req.method !== 'GET' || !/^\/draft-result\/?$/iu.test(req.path)) throw err;
          // Teachers with access may still read the saved result of a revoked class member.
          return teacher(req, res, authError => {
            if (authError) return next(authError);
            void assertTeacher(req, member).then(() => next(), next);
          });
        }
        next();
      });
    }
    app.use(sessions, ownerGuard('session'));
    app.use('/api/v1/attempts/:swRef', ownerGuard('attempt'));
  }

  return { install, runSweep, syncActivity, enrichRoster, allowAdds };
}
