import assert from 'node:assert/strict';
import {mkdtempSync, renameSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {createLesson5CourseRoster, lesson5TeacherRegistry, parseLesson5Roster} from '../src/lesson5-course-roster.mjs';
import {hasTeacherClass} from '../src/teacher-registry.mjs';

const student = studentRef => ({studentRef, displayName:'Cùng tên'});
const row = (classRef, students = []) => ({classRef, className:classRef, students});
const grant = (email, subject, classes) => ({email, subject, classes});
const fixture = () => ({course:'67', observedAt:new Date().toISOString(), classes:[row('IC1234',[student('one'),student('two')])], teachers:[]});

test('Lesson 5 accepts only fresh K67 roster, preserving student IDs with duplicate names', () => {
  const snapshot = fixture();
  const asOf = Date.parse(snapshot.observedAt);
  assert.deepEqual(parseLesson5Roster(snapshot, asOf).classes[0].students.map(s => [s.studentRef, s.displayName]),
    [['one', 'Cùng tên · Học viên 1'], ['two', 'Cùng tên · Học viên 2']]);
  assert.throws(() => parseLesson5Roster({...snapshot,course:'56'}, asOf), /INVALID/);
  assert.throws(() => parseLesson5Roster(snapshot, asOf+37*3600000), /STALE/);
  assert.throws(() => parseLesson5Roster({...snapshot,teachers:[grant('teacher@example.test','a',['IC9999'])]}, asOf), /INVALID/);
});

test('Lesson 5 reads an atomically added class without restarting and rejects a damaged feed', t => {
  const dir = mkdtempSync(join(tmpdir(),'lesson5-roster-'));
  t.after(() => rmSync(dir,{force:true,recursive:true}));
  const path = join(dir,'roster.json'), temporary = join(dir,'next.json');
  const snapshot = fixture();
  writeFileSync(path,JSON.stringify(snapshot));
  const errors = [];
  const current = createLesson5CourseRoster(path,code => errors.push(code));
  assert.deepEqual(current().refs,['IC1234']);
  writeFileSync(temporary,JSON.stringify({...snapshot,classes:[...snapshot.classes,row('IC5678')]}));
  renameSync(temporary,path);
  assert.deepEqual(current().refs,['IC1234','IC5678']);
  writeFileSync(path,'{');
  assert.equal(current(),null);
  assert.equal(current(),null);
  assert.deepEqual(errors,['LESSON5_ROSTER_UNAVAILABLE']);
});

test('Lesson 5 teacher grants cannot authorize a different class, lesson or Google subject', () => {
  const existing = {email:'existing@example.test',displayName:'Existing',subject:'original',classes:['IC2304']};
  const current = {teachers:[existing]};
  const snapshot = parseLesson5Roster({...fixture(),teachers:[
    grant(existing.email,'mismatch',['IC1234']), grant('new@example.test','verified',['IC1234']),
  ]});
  const after = lesson5TeacherRegistry(current,snapshot);
  assert.deepEqual(after.teachers[0],existing);
  const added = after.teachers[1];
  assert.equal(hasTeacherClass(added,'IC1234','lesson5'),true);
  assert.equal(hasTeacherClass(added,'IC2304','lesson5'),false);
  assert.equal(hasTeacherClass(added,'IC1234','lesson4'),false);
  assert.deepEqual(lesson5TeacherRegistry(current,null),current);
});
