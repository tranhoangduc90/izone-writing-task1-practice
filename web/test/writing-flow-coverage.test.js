import assert from 'node:assert/strict';
import test from 'node:test';
import { coverageDescription, coverageStatusLabels } from '../js/writing-flow-coverage.js';

test('mọi trạng thái độ phủ lớp có nhãn và giải thích dễ hiểu', () => {
  for (const status of ['covered', 'missing_source', 'mapping_issue',
    'unexpected_source', 'excluded', 'class_code_missing']) {
    assert.equal(typeof coverageStatusLabels[status], 'string');
    assert.equal(coverageStatusLabels[status].length > 5, true);
    assert.equal(coverageDescription({ status }).length > 20, true);
  }
  assert.match(coverageDescription({ status: 'excluded' }), /IC2288/u);
});
