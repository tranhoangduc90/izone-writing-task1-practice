import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("sample manifest follows the public v1 shape and contains no sensitive fields", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifests", "sample-task.json"), "utf8"));
  assert.equal(manifest.schema_version, "task1-web-manifest-v1");
  assert.match(manifest.activity.id, /^[0-9a-f-]{36}$/i);
  assert.equal(manifest.activity.slug, "sample-task");
  assert.ok(manifest.task.statement);
  assert.ok(manifest.analysis.bullets.length);
  assert.equal(manifest.routes.filter((route) => route.recommended).length, 1);
  assert.doesNotMatch(JSON.stringify(manifest), /grader.?prompt|credential|api.?key|student.?data|Bearer /i);
});

test("public config only contains the API base URL", () => {
  const config = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  assert.deepEqual(Object.keys(config), ["apiBase"]);
  assert.doesNotMatch(JSON.stringify(config), /token|secret|credential|authorization/i);
});
