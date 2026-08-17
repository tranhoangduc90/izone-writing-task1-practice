import test from "node:test";
import assert from "node:assert/strict";
import { manifestVocabularyRows } from "../js/vocabulary-ui.js";

test("normalizes both simple and grouped vocabulary manifests", () => {
  assert.deepEqual(manifestVocabularyRows([
    { vi: "tăng", en: "increase" },
    { meaning: "giảm", term: "decrease" },
  ]), [
    { vi: "tăng", en: "increase" },
    { vi: "giảm", en: "decrease" },
  ]);

  assert.deepEqual(manifestVocabularyRows({
    overview: { naming: [{ vi: "số liệu", en: "figure" }], insights: [{ vi: "nhìn chung", en: "overall" }] },
    routes: [{ naming: [{ vi: "đứng đầu", en: "rank first" }], story: [{ vi: "tăng nhanh", en: "grow rapidly" }] }],
  }), [
    { vi: "số liệu", en: "figure" },
    { vi: "nhìn chung", en: "overall" },
    { vi: "đứng đầu", en: "rank first" },
    { vi: "tăng nhanh", en: "grow rapidly" },
  ]);
});

test("drops empty vocabulary rows and keeps alternate field names", () => {
  assert.deepEqual(manifestVocabularyRows([
    {},
    { idea: "mức cao nhất", terms: "the highest figure" },
  ]), [{ vi: "mức cao nhất", en: "the highest figure" }]);
});
