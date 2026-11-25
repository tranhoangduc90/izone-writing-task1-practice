import {readFileSync, statSync} from 'node:fs';

const maxAgeMs = 36 * 60 * 60 * 1000;
const nonempty = value => typeof value === 'string' && !!value.trim();
const unique = values => new Set(values).size === values.length;

export function parseLesson5Roster(value, now = Date.now()) {
  if (value?.course !== '67' || !Array.isArray(value.classes) || !value.classes.length || !Array.isArray(value.teachers)) {
    throw Error('LESSON5_ROSTER_INVALID');
  }
  const observed = Date.parse(value.observedAt);
  if (!Number.isFinite(observed) || observed > now || now - observed > maxAgeMs) throw Error('LESSON5_ROSTER_STALE');
  const refs = value.classes.map(row => row.classRef);
  if (!unique(refs) || value.classes.some(row => !nonempty(row.classRef) || !nonempty(row.className) ||
    !Array.isArray(row.students) || !unique(row.students.map(person => person.studentRef)) ||
    row.students.some(person => !nonempty(person.studentRef) || !nonempty(person.displayName)))) {
    throw Error('LESSON5_ROSTER_INVALID');
  }
  if (!unique(value.teachers.map(person => person.email)) || value.teachers.some(person =>
    !nonempty(person.email) || person.email !== person.email.toLowerCase() || !nonempty(person.subject) ||
    !Array.isArray(person.classes) || !person.classes.length || person.classes.some(ref => !refs.includes(ref)))) {
    throw Error('LESSON5_ROSTER_INVALID');
  }
  return {observed, refs, teachers: value.teachers, classes: value.classes.map(row => {
    const counts = new Map();
    for (const student of row.students) counts.set(student.displayName, (counts.get(student.displayName) || 0) + 1);
    const seen = new Map();
    const students = row.students.map(student => {
      const name = student.displayName;
      if (counts.get(name) === 1) return student;
      const number = (seen.get(name) || 0) + 1;
      seen.set(name, number);
      return {...student, displayName: `${name} · Học viên ${number}`};
    });
    return {...row, students};
  })};
}

export function createLesson5CourseRoster(path, onError) {
  let fileVersion, snapshot, lastError;
  return () => {
    try {
      const stat = statSync(path);
      const version = `${stat.ino}:${stat.mtimeMs}:${stat.size}`;
      if (fileVersion !== version) {
        snapshot = parseLesson5Roster(JSON.parse(readFileSync(path, 'utf8')));
        fileVersion = version;
      }
      if (Date.now() - snapshot.observed > maxAgeMs) throw Error('LESSON5_ROSTER_STALE');
      lastError = undefined;
      return snapshot;
    } catch (error) {
      const code = error.message === 'LESSON5_ROSTER_STALE' ? error.message : 'LESSON5_ROSTER_UNAVAILABLE';
      if (lastError !== code) onError(code);
      lastError = code;
      return null;
    }
  };
}

export function lesson5TeacherRegistry(registry, snapshot, activity = 'lesson5') {
  if (!snapshot) return registry;
  const accounts = new Map(registry.teachers.map(person => [person.email, person]));
  for (const grant of snapshot.teachers) {
    const current = accounts.get(grant.email);
    if (current && current.subject !== grant.subject) continue;
    const person = current || {email: grant.email, subject: grant.subject, classes: [], displayName: grant.displayName || grant.email};
    accounts.set(grant.email, {...person, lessonClasses: {...person.lessonClasses, [activity]: [
      ...new Set([...(person.lessonClasses?.[activity] || []), ...grant.classes]),
    ]}});
  }
  return {...registry, teachers: [...accounts.values()]};
}
