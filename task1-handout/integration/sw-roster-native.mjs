import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import request from 'supertest';
import { z } from 'zod';
import { createLessonPracticeService } from '../../backend/src/lesson-service.js';
import { createApp } from '../src/app.mjs';
import { createSwRosterApi } from '../vendor/sw-roster-api.mjs';
import { createSwRosterProjection } from '../vendor/sw-roster-projection.mjs';
import { createSwRosterRegistry } from '../vendor/sw-roster-registry.mjs';
import { adapt, setup } from '../test/helpers.mjs';

const schema = new URL('../../backend/ops/sw-task2-production/sw-roster-registry.sql', import.meta.url);

test('class membership and one-time claim keep same-name students apart while ERP is pending', async t => {
  const db = new PGlite();
  t.after(() => db.close());
  await db.exec(await readFile(schema, 'utf8'));
  const registry = createSwRosterRegistry({ pool: adapt(db), invitationKey: 'fixture-only-key-'.repeat(3) });
  const scope = { product: 'task1', activitySlug: 'test-current', classRef: randomUUID(), erpClassId: '999001' };
  const next = { ...scope, product: 'task2', activitySlug: 'test-future', classRef: randomUUID() };
  const input = { scope, actor: 'teacher@fixture.invalid', requestId: randomUUID(), displayName: '  Nguyễn   Văn An  ' };

  await assert.rejects(registry.add({ ...input, existingName: true }), { code: 'SW_ROSTER_DUPLICATE_NAME' });
  const [saved, replay] = await Promise.all([
    registry.add({ ...input, existingName: true, duplicateConfirmed: true }),
    registry.add({ ...input, existingName: true, duplicateConfirmed: true }),
  ]);
  assert.equal(saved.member.displayName, 'Nguyễn Văn An');
  assert.equal(saved.member.studentRef, replay.member.studentRef);
  assert.equal(saved.invitationToken, replay.invitationToken);
  assert.equal(replay.idempotent, true);
  await assert.rejects(registry.add({ ...input, scope: next }), { code: 'SW_ROSTER_REQUEST_REUSED' });
  await assert.rejects(registry.add({ ...input, requestId: randomUUID() }), { code: 'SW_ROSTER_DUPLICATE_NAME' });

  const other = await registry.add({ ...input, requestId: randomUUID(), duplicateConfirmed: true });
  assert.notEqual(other.member.studentRef, saved.member.studentRef);
  assert.equal((await registry.listActive(scope.erpClassId)).length, 2);
  await assert.rejects(registry.redeem({ scope: next, token: saved.invitationToken }),
    { code: 'SW_ROSTER_INVITATION_INVALID' });
  const claims = await Promise.allSettled([
    registry.redeem({ scope, token: saved.invitationToken }),
    registry.redeem({ scope, token: saved.invitationToken }),
  ]);
  assert.equal(claims.filter(result => result.status === 'fulfilled').length, 1);
  const { member, credential } = claims.find(result => result.status === 'fulfilled').value;
  assert.equal(member.studentRef, saved.member.studentRef);
  assert.equal(member.reconciliationStatus, 'pending_erp');
  assert.equal((await registry.add(input)).invitationToken, null);

  assert.equal(await registry.canAccess({ ...next, studentRef: member.studentRef, credential }), true);
  assert.equal(await registry.canAccess({ ...next, studentRef: other.member.studentRef, credential }), false);
  assert.equal(await registry.canAccess({ erpClassId: '999002', studentRef: member.studentRef, credential }), false);
  const stored = await db.query('SELECT token_hash,credential_hash FROM sw_roster.invitation');
  assert.doesNotMatch(JSON.stringify(stored.rows), new RegExp(`${credential}|${saved.invitationToken}`, 'u'));

  const renewed = await registry.reissue({
    scope: next, actor: input.actor, requestId: randomUUID(), studentRef: member.studentRef,
  });
  assert.equal((await registry.redeem({ scope: next, token: renewed.invitationToken })).member.studentRef, member.studentRef);
  await db.query('UPDATE sw_roster.member SET active=false WHERE student_ref=$1', [member.studentRef]);
  assert.equal(await registry.canAccess({ ...next, studentRef: member.studentRef, credential }), false);
  assert.equal((await registry.listActive(next.erpClassId)).length, 1);
});

test('a pending class member reaches the native session owners in two separate databases', async t => {
  const current = await setup(t);
  const futureDb = new PGlite();
  t.after(() => futureDb.close());
  const [baseSql, projectionSql, registrySql] = await Promise.all([
    readFile(new URL('../db/001-initial.sql', import.meta.url), 'utf8'),
    readFile(new URL('../db/005-sw-roster-projection.sql', import.meta.url), 'utf8'),
    readFile(schema, 'utf8'),
  ]);
  await current.db.exec(projectionSql);
  await futureDb.exec(baseSql);
  await futureDb.exec(projectionSql);
  await futureDb.exec(registrySql);
  const futurePool = adapt(futureDb);
  const registry = createSwRosterRegistry({ pool: futurePool, invitationKey: 'fixture-only-key-'.repeat(3) });
  const task1 = createSwRosterProjection({ pool: current.pool, product: 'task1' });
  const task2 = createSwRosterProjection({ pool: futurePool, product: 'task2' });
  const oldSession = await current.service.sessionDetails(current.sessionRef);
  await current.pool.query(`UPDATE writing_practice.activity_class_scope SET class_name_snapshot='CS.999001'`);
  const scope = await task1.resolveScope('task1-fixture', current.classRef);
  const saved = await registry.add({
    scope, actor: 'teacher@fixture.invalid', requestId: randomUUID(),
    displayName: 'Học viên thử', existingName: true, duplicateConfirmed: true,
  });
  await Promise.all([task1.apply(scope, saved.member), task1.apply(scope, saved.member)]);
  const claim = await registry.redeem({ scope, token: saved.invitationToken });
  const access = await task1.managedStudent(scope.classRef, claim.member.studentRef);
  assert.equal(access.open, true);
  assert.equal(await registry.canAccess({ ...access, credential: claim.credential }), true);
  const currentSession = await current.service.openSession({
    ...scope, studentRef: claim.member.studentRef,
  });
  assert.notEqual(currentSession.sessionRef, oldSession.sessionRef);
  assert.equal(currentSession.studentRef, claim.member.studentRef);
  assert.equal((await current.service.sessionDetails(oldSession.sessionRef)).studentRef, oldSession.studentRef);
  assert.deepEqual(await task2.listScopes(scope.erpClassId), []);

  // The second engine starts with a different DB and a different per-activity classRef.
  await futureDb.exec(`
    ALTER TABLE writing_practice.activity_section_definition
      ADD COLUMN prerequisite_sections jsonb NOT NULL DEFAULT '[]';
    INSERT INTO writing_practice.activity
      (slug,content_version,manifest_checksum,title,task_prompt,prompt_record_ref,prompt_version,end_date,status,grading_pool)
    VALUES('task2-later','test',repeat('a',64),'Bài mở sau','Đề bài','fixture','test','2030-12-31','active','task2');
    INSERT INTO writing_practice.activity_class_scope (activity_id,erp_course_class_id,class_name_snapshot,end_date)
    SELECT id,999001,'CS.999001','2030-12-31' FROM writing_practice.activity;
    INSERT INTO writing_practice.activity_section_definition (activity_id,section_key,title,sort_order,input_fields)
    SELECT id,'overview','Phần thử',1,'["overview"]' FROM writing_practice.activity;
  `);
  const [futureScope] = await task2.listScopes(scope.erpClassId);
  assert.notEqual(futureScope.classRef, scope.classRef);
  const [pendingMember] = await registry.listActive(scope.erpClassId);
  await task2.apply(futureScope, pendingMember);
  const futureAccess = await task2.managedStudent(futureScope.classRef, pendingMember.studentRef);
  assert.equal(await registry.canAccess({ ...futureAccess, credential: claim.credential }), true);
  const lesson = createLessonPracticeService({ pool: futurePool });
  const futureSession = await lesson.openSession({ ...futureScope, studentRef: pendingMember.studentRef });
  assert.equal(futureSession.studentRef, currentSession.studentRef);
  assert.equal(pendingMember.reconciliationStatus, 'pending_erp');
  assert.equal((await task1.managedStudent(scope.classRef, oldSession.studentRef)), null);
  await assert.rejects(task1.apply(scope, { ...pendingMember, studentRef: oldSession.studentRef }),
    { code: 'SW_ROSTER_PROJECTION_CONFLICT' });
  assert.equal((await current.service.getRoster(scope.activitySlug)).classes[0].students.length, 2);
});

test('Task 1 HTTP binds a single name-only save, invitation and managed session to the authorized class', async t => {
  const fixture = await setup(t);
  await fixture.db.exec(await readFile(schema, 'utf8'));
  await fixture.db.exec(await readFile(new URL('../db/005-sw-roster-projection.sql', import.meta.url), 'utf8'));
  await fixture.pool.query("UPDATE writing_practice.activity_class_scope SET class_name_snapshot='CS.999001'");
  const teacherEmail = 'teacher@fixture.invalid';
  const outsiderEmail = 'outsider@fixture.invalid';
  for (const [email, refs] of [[teacherEmail, [fixture.classRef]], [outsiderEmail, []]]) {
    await fixture.pool.query('INSERT INTO task1_private.teacher_grant VALUES($1,$2,$3,true,$4::uuid[])',
      [email, email, 'teacher', refs]);
  }
  const registry = createSwRosterRegistry({ pool: fixture.pool, invitationKey: 'fixture-only-key-'.repeat(3) });
  const projection = createSwRosterProjection({ pool: fixture.pool, product: 'task1' });
  const logs = [];
  let failCurrent = true;
  const project = projection.apply;
  projection.apply = (...args) => {
    if (failCurrent) throw Object.assign(Error('simulated outage'), { code: 'TEST_UNAVAILABLE' });
    return project(...args);
  };
  const origin = 'http://fixture.invalid';
  const origins = new Set([origin]);
  const swRoster = createSwRosterApi({
    z, product: 'task1', registry, projection, allowedOrigins: origins, allowAdds: true, cookieSecure: false,
    log: event => logs.push(event),
  });
  const app = createApp({ ...fixture, config: { origins }, swRoster, verifyTeacher: async req => {
    const email = req.get('x-fixture-teacher');
    if (!email) throw Object.assign(Error('missing test session'), { status: 401 });
    return { email, sub: email };
  } });
  const slug = 'task1-fixture';
  const addUrl = `/api/v1/admin/activities/${slug}/class-members`;
  const claimUrl = `/api/v1/activities/${slug}/class-members/claim`;
  const write = (path, data) => request(app).post(path).set('Origin', origin).set('X-Izone-Csrf', '1').send(data);
  const input = { classRef: fixture.classRef, displayName: 'Học viên mới', requestId: randomUUID() };

  await write(addUrl, input).expect(401);
  await write(addUrl, input).set('x-fixture-teacher', outsiderEmail).expect(403);
  await write(addUrl, { ...input, classRef: randomUUID() }).set('x-fixture-teacher', teacherEmail).expect(403);
  await request(app).post(addUrl).set('Origin', origin).set('x-fixture-teacher', teacherEmail).send(input).expect(403);
  const pending = await write(addUrl, input).set('x-fixture-teacher', teacherEmail).expect(202);
  assert.equal(pending.body.state, 'current_pending');
  assert.equal(pending.body.invitationToken, undefined);
  failCurrent = false;
  const [added, retried] = await Promise.all([
    write(addUrl, input).set('x-fixture-teacher', teacherEmail).expect(200),
    write(addUrl, input).set('x-fixture-teacher', teacherEmail).expect(200),
  ]);
  const { member, invitationToken } = added.body;
  assert.equal(member.studentRef, pending.body.member.studentRef);
  assert.equal(retried.body.invitationToken, invitationToken);

  const classRead = await request(app).get(addUrl).query({ classRef: input.classRef })
    .set('x-fixture-teacher', teacherEmail).expect(200);
  assert.equal(classRead.body.members.length, 1);
  assert.equal(classRead.body.members[0].currentReady, true);
  const roster = await request(app).get(`/api/v1/activities/${slug}/roster`).expect(200);
  assert.equal(roster.body.classes[0].students.find(student => student.studentRef === member.studentRef).classManaged, true);
  const open = { classRef: input.classRef, activitySlug: slug, studentRef: member.studentRef };
  await write('/api/v1/sessions', open).expect(401);
  await write(claimUrl, { classRef: input.classRef, token: 'Z'.repeat(43) }).expect(401);
  const claimed = await write(claimUrl, { classRef: input.classRef, token: invitationToken }).expect(200);
  const cookie = claimed.headers['set-cookie'][0].split(';')[0];
  assert.match(claimed.headers['set-cookie'][0], /HttpOnly/u);
  assert.equal(claimed.body.studentRef, member.studentRef);
  await write(claimUrl, { classRef: input.classRef, token: invitationToken }).expect(401);
  const opened = await write('/api/v1/sessions', open).set('Cookie', cookie).expect(201);
  assert.equal(opened.body.session.studentRef, member.studentRef);
  const sessionPath = `/api/v1/sessions/${opened.body.session.sessionRef}`;
  await request(app).get(sessionPath).expect(401);
  await request(app).get(sessionPath).set('Cookie', cookie).expect(200);
  await request(app).get(`/api/v1/admin/live/sessions/${opened.body.session.sessionRef}`)
    .set('x-fixture-teacher', teacherEmail).expect(200);
  await request(app).get(`/api/v1/sessions/${fixture.sessionRef}`).expect(200);
  assert.equal(logs.filter(item => item.event === 'sw_roster_save').length, 3);
  assert.doesNotMatch(JSON.stringify(logs), /Học viên mới|fixture.invalid/u);

  await fixture.pool.query('DELETE FROM writing_practice.activity_roster WHERE student_public_id=$1', [member.studentRef]);
  await request(app).get(sessionPath).expect(401);
  await request(app).get(sessionPath).set('Cookie', cookie).expect(401);
  await swRoster.runSweep();
  await request(app).get(sessionPath).set('Cookie', cookie).expect(200);

  await fixture.pool.query('UPDATE sw_roster.member SET active=false WHERE student_ref=$1', [member.studentRef]);
  await request(app).get(sessionPath).set('Cookie', cookie).expect(401);
  await swRoster.runSweep();
  const after = await request(app).get(`/api/v1/activities/${slug}/roster`).expect(200);
  assert.deepEqual(after.body.classes[0].students.map(row => row.studentRef), [fixture.studentRef]);
});
