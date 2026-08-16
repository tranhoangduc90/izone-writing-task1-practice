import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { teacherAuthFailure } from "../js/teacher-auth-ui.js";

test("dashboard đưa phiên hết hạn về màn hình đăng nhập", () => {
  const result = teacherAuthFailure(401);
  assert.equal(result.header, "Chưa đăng nhập");
  assert.match(result.message, /đăng nhập lại/i);
});

test("dashboard nói rõ tài khoản Google không có quyền thay vì báo lỗi tải chung", () => {
  const result = teacherAuthFailure(403);
  assert.equal(result.header, "Tài khoản chưa có quyền");
  assert.match(result.message, /chưa được cấp quyền/i);
  assert.match(result.message, /chọn tài khoản quản trị/i);
});

test("lỗi tạm thời không bị hiểu nhầm thành lỗi đăng nhập", () => {
  assert.equal(teacherAuthFailure(429), null);
  assert.equal(teacherAuthFailure(500), null);
});

test("tài khoản chỉ xem không được hiện nút quản trị học viên", () => {
  const source = fs.readFileSync(new URL("../js/teacher-app.js", import.meta.url), "utf8");
  assert.match(source, /if \(state\.canManage\)/);
  assert.match(source, /Chỉ xem · Tài khoản quản trị sẽ đối soát hồ sơ này/);
  assert.match(source, /result\.data\.permissions\?\.canManage === true/);
});
