import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xiaoyi-usage-"));
process.env.MAGPIE_XIAOYIWORK_STATE_DIR = dir;

const { usageHook } = await import("../src/hooks/usage.mjs");

const UID = "1234567890";
const stateFile = () => path.join(dir, `xiaoyiwork-points.${UID}.json`);
const read = () => JSON.parse(fs.readFileSync(stateFile(), "utf8"));
const write = (v) =>
  fs.writeFileSync(stateFile(), JSON.stringify(v), { mode: 0o600 });

const auth = {
  access: "cred",
  uid: UID,
  deviceId: "dev_1",
  accountId: "测试号",
};
const getAuth = async () => auth;

const goodWindow = {
  name: "会员积分（体验版）",
  display: "剩余 200 点（免费 200）",
  balance: 200,
  unit: "点",
};

test("上游全挂时回落到上一次成功结果，且不删掉它", async () => {
  write({
    bucket: { membership: 200 },
    lastGood: {
      at: "2026-11-26T07:20:17.785Z",
      plan: "体验版",
      windows: [goodWindow],
    },
  });

  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const hook = usageHook();
    const first = await hook(getAuth, null, {});
    assert.equal(first.windows.length, 1);
    assert.match(first.error, /上一次结果/);
    // ⚠ 这正是之前的 bug：失败分支把 lastGood 写掉了，下一次就再也没得回落
    assert.ok(read().lastGood?.windows?.length, "lastGood 必须留在状态文件里");

    const second = await hook(getAuth, null, {});
    assert.equal(second.windows.length, 1, "第二次失败仍然要能回落");
    assert.match(second.error, /上一次结果/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("没有 lastGood 且上游全挂时如实报错，不编窗口", async () => {
  write({ bucket: {} });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("network down");
  };
  try {
    const r = await usageHook()(getAuth, null, {});
    assert.deepEqual(r.windows, []);
    assert.match(r.error, /没拿到数据/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("读到额度时写入 lastGood 与总量观测值", async () => {
  // 之前观测到过 200，这次剩 180 —— 分母应该沿用 200，而不是把 180 当总量
  write({ bucket: { membership: 200 } });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const payload =
      body.agentId === "1"
        ? {
            celiaPremiumPrivilege: {
              aiPoints: { totalPoints: 180, freePoints: 200 },
              membership: { skuGroupName: "体验版" },
            },
          }
        : {
            privilegeList: [
              {
                privilegeId: "p1",
                privilegeName: "首月权益包",
                privilegeDetail: ["剩余积分：1000"],
                expireTime: "20261216235959",
              },
            ],
          };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const r = await usageHook()(getAuth, null, {});
    assert.equal(r.windows.length, 2);
    assert.equal(r.plan, "体验版");
    const saved = read();
    assert.equal(saved.lastGood.windows.length, 2);
    // 观测到过 200，所以会员池现在知道分母
    assert.equal(saved.bucket.membership, 200);
    const membership = r.windows.find((w) => w.name.includes("会员积分"));
    assert.equal(membership.limit, 200);
    assert.equal(membership.amount, 20);
    assert.equal(membership.used, 10);
    const pack = r.windows.find((w) => w.name.includes("权益包"));
    assert.ok(pack.runsOutAt, "权益包要带作废时间");
  } finally {
    globalThis.fetch = realFetch;
  }
});
