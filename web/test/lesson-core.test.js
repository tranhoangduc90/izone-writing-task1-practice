import test from "node:test";
import assert from "node:assert/strict";
import { normalizeLessonProgress, sectionIsFilled, sectionPrerequisitesPassed, vocabularyPrerequisitesPassed } from "../js/lesson-core.js";

const manifest = {
  sections: [{
    key: "body1_topic",
    fields: [{ key: "idea1" }, { key: "idea2" }, { key: "topic" }],
    requiredFields: ["idea1", "idea2", "topic"],
    validationMode: "all",
  }],
};

test("Lesson progress keeps dynamic response and section keys", () => {
  const result = normalizeLessonProgress({ draftVersion: 3, responses: { idea1: "A", idea2: "B", topic: "T" }, sections: { body1_topic: { status: "revision", attemptsWithoutPass: 3 } } }, manifest);
  assert.equal(result.revision, 3);
  assert.equal(result.responses.topic, "T");
  assert.equal(result.sections.body1_topic.status, "revision");
  assert.equal(result.sections.body1_topic.attemptsWithoutPass, 3);
});

test("Lesson Check requires all configured fields and ignores invisible characters", () => {
  const section = manifest.sections[0];
  assert.equal(sectionIsFilled(section, { idea1: "A", idea2: "B", topic: "T" }), true);
  assert.equal(sectionIsFilled(section, { idea1: "A", idea2: "B", topic: " \u200B " }), false);
});

test("Task 2 chỉ mở phần tiếp theo và bảng từ vựng sau khi đủ điều kiện", () => {
  const states = {
    topic_sentence: { status: "passed" },
    supporting_idea_1: { status: "revision" },
    supporting_idea_2: { status: "draft" },
  };
  assert.equal(sectionPrerequisitesPassed({ prerequisites: ["topic_sentence"] }, states), true);
  assert.equal(sectionPrerequisitesPassed({ prerequisites: ["topic_sentence", "supporting_idea_1"] }, states), false);
  assert.equal(vocabularyPrerequisitesPassed({ unlockAfter: ["topic_sentence", "supporting_idea_1", "supporting_idea_2"] }, states), false);
  states.supporting_idea_1.status = "passed";
  states.supporting_idea_2.status = "passed";
  assert.equal(vocabularyPrerequisitesPassed({ unlockAfter: ["topic_sentence", "supporting_idea_1", "supporting_idea_2"] }, states), true);
});
