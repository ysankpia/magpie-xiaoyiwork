import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { slotsForUid, entriesForUid } from "../src/duplicate.mjs";

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

test("entriesForUid 带出凭据和 deviceId，供调用方探测旧票", () => {
  write({
    xiaoyiwork: { uid: "111", access: "cred-a", deviceId: "dev_a" },
    "xiaoyiwork#s1": {
      metadata: { uid: "111", deviceId: "dev_b" },
      access: "cred-b",
    },
  });
  const got = entriesForUid(dir, "xiaoyiwork", "111").sort((a, b) =>
    a.key.localeCompare(b.key),
  );
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], {
    key: "xiaoyiwork",
    credential: "cred-a",
    uid: "111",
    deviceId: "dev_a",
  });
  assert.deepEqual(got[1], {
    key: "xiaoyiwork#s1",
    credential: "cred-b",
    uid: "111",
    deviceId: "dev_b",
  });
});
