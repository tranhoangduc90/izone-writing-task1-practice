import test from "node:test";
import assert from "node:assert/strict";
import { classQuery, resolveClassRef } from "../js/class-selection.js";

const classes = [
  { classRef: "class-160826", className: "CS.160826" },
  { classRef: "class-070626", className: "CS.070626" },
];

test("URL không có class thì không chọn sẵn lớp", () => {
  assert.equal(classQuery("?task=writing-task2"), "");
  assert.equal(resolveClassRef(classes, ""), "");
});

test("URL có class chọn đúng lớp theo tên, không phân biệt hoa thường", () => {
  assert.equal(classQuery("?task=writing-task2&class=CS.070626"), "CS.070626");
  assert.equal(resolveClassRef(classes, "cs.070626"), "class-070626");
});

test("URL cũng chấp nhận public class reference và từ chối lớp không tồn tại", () => {
  assert.equal(resolveClassRef(classes, "class-160826"), "class-160826");
  assert.equal(resolveClassRef(classes, "CS.999999"), "");
});
