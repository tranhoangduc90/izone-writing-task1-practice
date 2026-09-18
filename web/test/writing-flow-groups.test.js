import assert from 'node:assert/strict';
import test from 'node:test';
import { groupWritingPairs } from '../js/writing-flow-groups.js';

test('20 bài ở nhiều lớp, hồ sơ và link đều còn đúng nhóm', () => {
  const pairs = Array.from({ length: 20 }, (_, index) => ({
    pair_id: `pair-${index + 1}`,
    class_code: index < 10 ? 'IC2201' : 'IC2202',
    source_app_id: 'app-demo', source_table_id: 'table-demo',
    source_record_id: `record-${Math.floor(index / 5) + 1}`,
    homework_file_id: `doc-${Math.floor(index / 2) + 1}`,
    source_link_index: index % 2 + 1,
    essay_slot: index % 4 + 1,
  }));
  const groups = groupWritingPairs(pairs);
  assert.deepEqual(groups.map(group => group.classCode), ['IC2201', 'IC2202']);
  assert.deepEqual(groups.map(group => group.homeworks.length), [2, 2]);
  const flattened = groups.flatMap(group => group.homeworks
    .flatMap(homework => homework.files.flatMap(file => file.pairs)));
  assert.deepEqual(flattened.map(pair => pair.pair_id), pairs.map(pair => pair.pair_id));
  assert.equal(new Set(flattened.map(pair => pair.pair_id)).size, 20);
});

test('mã hồ sơ giống nhau nhưng khác ứng dụng không bị gộp', () => {
  const pairs = [
    { pair_id: 'one', class_code: 'IC2201', source_app_id: 'app-a',
      source_table_id: 'table', source_record_id: 'record',
      homework_file_id: 'doc', source_link_index: 1 },
    { pair_id: 'two', class_code: 'IC2201', source_app_id: 'app-b',
      source_table_id: 'table', source_record_id: 'record',
      homework_file_id: 'doc', source_link_index: 1 },
  ];
  assert.equal(groupWritingPairs(pairs)[0].homeworks.length, 2);
});

test('hai bài thiếu mã nguồn vẫn hiển thị tách biệt', () => {
  const pairs = [
    { pair_id: 'one', class_code: 'IC2201' },
    { pair_id: 'two', class_code: 'IC2201' },
  ];
  const homeworks = groupWritingPairs(pairs)[0].homeworks;
  assert.equal(homeworks.length, 2);
  assert.deepEqual(homeworks.flatMap(homework => homework.files.flatMap(file => file.pairs))
    .map(pair => pair.pair_id), ['one', 'two']);
});

test('hai bài trong cùng một link homework nằm chung file', () => {
  const source = { class_code: 'IC2201', source_app_id: 'app',
    source_table_id: 'table', source_record_id: 'record',
    homework_file_id: 'doc', source_link_index: 1 };
  const files = groupWritingPairs([
    { ...source, pair_id: 'one', essay_slot: 1 },
    { ...source, pair_id: 'two', essay_slot: 2 },
  ])[0].homeworks[0].files;
  assert.equal(files.length, 1);
  assert.deepEqual(files[0].pairs.map(pair => pair.pair_id), ['one', 'two']);
});
