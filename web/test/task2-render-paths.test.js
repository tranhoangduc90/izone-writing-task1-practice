import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = relative => fs.readFileSync(new URL(relative, import.meta.url), 'utf8');

test('Task 2 student app renders choice, gated vocabulary and inline Draft LMS cards', () => {
  const app = read('../js/lesson-app.js');
  const api = read('../js/api.js');
  const styles = read('../styles.css');
  assert.match(app, /function addChoice/);
  assert.match(app, /vocabularyPrerequisitesPassed/);
  assert.match(app, /bodySelectorField/);
  assert.match(app, /renderLmsDraftResult/);
  assert.match(api, /lesson-sessions\/\$\{encodeURIComponent\(sessionRef\)\}\/draft-result/);
  assert.match(styles, /\.task2-draft-vocabulary \.table-scroll[^}]+max-height:[^}]+overflow:auto/);
});
