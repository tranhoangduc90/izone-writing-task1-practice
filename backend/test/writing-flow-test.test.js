import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateTestTaskScore,
  calculateTestWritingScore,
  normalizeWritingTestResult,
} from '../src/writing-flow-test.js';

const taskDefinitions = {
  1: {
    TA: ['ta_key_features_overview', 'ta_data_support'],
    CC: ['cc_organization', 'cc_cohesive_devices', 'cc_referencing'],
    LR: ['lr_range', 'lr_word_choice', 'lr_word_formation_spelling'],
    GRA: ['gra_detail'],
  },
  2: {
    TR: ['tr_task_coverage', 'tr_position', 'tr_idea_development'],
    CC: ['cc_organization', 'cc_cohesive_devices', 'cc_referencing'],
    LR: ['lr_range', 'lr_word_choice', 'lr_word_formation_spelling'],
    GRA: ['gra_detail'],
  },
};

function result(taskNumber, scores = [6.5, 7, 6.5, 7]) {
  return {
    criteria: Object.entries(taskDefinitions[taskNumber]).map(([code, components], index) => ({
      code,
      name: code,
      bandScore: scores[index],
      feedback: `Nhận xét ${code}`,
      components: components.map(componentCode => ({
        code: componentCode,
        label: componentCode,
        summary: `Tóm tắt ${componentCode}`,
        feedback: `Phản hồi ${componentCode}`,
      })),
    })),
    taskScore: 6.5,
    report: 'Nhận xét tổng hợp',
  };
}

test('Task 1 chỉ nhận đủ đúng 9 khía cạnh và tự tính lại điểm', () => {
  const normalized = normalizeWritingTestResult(1, result(1));
  assert.equal(normalized.componentCount, 9);
  assert.equal(normalized.criteria.length, 4);
  assert.equal(normalized.taskScore, 6.5);
});

test('Task 2 chỉ nhận đủ đúng 10 khía cạnh', () => {
  const normalized = normalizeWritingTestResult(2, result(2));
  assert.equal(normalized.componentCount, 10);
  assert.deepEqual(normalized.criteria.map(item => item.code), ['TR', 'CC', 'LR', 'GRA']);
});

test('thiếu, thừa hoặc trùng khía cạnh đều bị chặn trước khi lưu', () => {
  const missing = result(2);
  missing.criteria[0].components.pop();
  assert.throws(() => normalizeWritingTestResult(2, missing),
    error => error.code === 'TEST_RESULT_COMPONENTS_INCOMPLETE');
  const extra = result(1);
  extra.criteria[0].components.push({ code: 'extra', label: 'extra' });
  assert.throws(() => normalizeWritingTestResult(1, extra),
    error => error.code === 'TEST_RESULT_COMPONENTS_INCOMPLETE');
  const duplicate = result(1);
  duplicate.criteria[1].components[1].code = duplicate.criteria[1].components[0].code;
  assert.throws(() => normalizeWritingTestResult(1, duplicate),
    error => error.code === 'TEST_RESULT_COMPONENTS_INCOMPLETE');
});

test('điểm AI khai báo sai bị chặn; backend dùng công thức đã duyệt', () => {
  const mismatched = result(2);
  mismatched.taskScore = 8;
  assert.throws(() => normalizeWritingTestResult(2, mismatched),
    error => error.code === 'TEST_RESULT_SCORE_MISMATCH');
  assert.equal(calculateTestTaskScore(result(1).criteria), 6.5);
  assert.equal(calculateTestWritingScore(6.5, 7), 7);
});

test('kết quả có thể nằm trong vỏ result của workflow con', () => {
  const normalized = normalizeWritingTestResult(2, { result: result(2) });
  assert.equal(normalized.taskScore, 6.5);
});
