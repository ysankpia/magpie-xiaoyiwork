import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { slotsForUid } from "../src/duplicate.mjs";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoyi-dup-"));
const write = (v) =>
  fs.writeFileSync(path.join(dir, "plugin-auth.json"), JSON.stringify(v));

test("找到同一 uid 的首槽位与 #slot 槽位", () => {
  write({
    xiaoyiwork: { uid: "111" },
    "xiaoyiwork#abc123": { uid: "111" },
    "xiaoyiwork#def456": { uid: "222" },
    trae: { uid: "111" },
  });
  assert.deepEqual(slotsForUid(dir, "xiaoyiwork", "111").sort(), [
    "xiaoyiwork",
    "xiaoyiwork#abc123",
  ]);
  assert.deepEqual(slotsForUid(dir, "xiaoyiwork", "222"), [
    "xiaoyiwork#def456",
  ]);
  assert.deepEqual(slotsForUid(dir, "xiaoyiwork", "999"), []);
});

test("uid 在 metadata 里也算", () => {
  write({ xiaoyiwork: { metadata: { uid: "777" } } });
  assert.deepEqual(slotsForUid(dir, "xiaoyiwork", "777"), ["xiaoyiwork"]);
});

test("读不到文件时放行（宁可让用户加，也别卡死登录）", () => {
  assert.deepEqual(
    slotsForUid(path.join(dir, "nope"), "xiaoyiwork", "111"),
    [],
  );
  assert.deepEqual(slotsForUid(null, "xiaoyiwork", "111"), []);
  assert.deepEqual(slotsForUid(dir, "xiaoyiwork", ""), []);
});
