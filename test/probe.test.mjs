import test from "node:test";
import assert from "node:assert/strict";
import { probeCredential } from "../src/xiaoyi/billing.mjs";

const state = { credential: "cred", uid: "111", deviceId: "dev_111" };

async function withFetch(impl, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
}

test("旧票还能用 → alive（这是真的重复添加）", async () => {
  const got = await withFetch(
    async () => new Response("{}", { status: 200 }),
    () => probeCredential(state),
  );
  assert.equal(got, "alive");
});

test("旧票 401 → dead（这是重新登录，必须放行）", async () => {
  const got = await withFetch(
    async () => new Response("{}", { status: 401 }),
    () => probeCredential(state),
  );
  assert.equal(got, "dead");
});

test("网络挂了 → unknown，不因此拦住登录", async () => {
  const got = await withFetch(
    async () => {
      throw new Error("offline");
    },
    () => probeCredential(state),
  );
  assert.equal(got, "unknown");
});

test("没有凭据直接算 dead，不发请求", async () => {
  let called = false;
  const got = await withFetch(
    async () => {
      called = true;
      return new Response("{}", { status: 200 });
    },
    () => probeCredential({ credential: null, uid: "111", deviceId: "d" }),
  );
  assert.equal(got, "dead");
  assert.equal(called, false);
});
