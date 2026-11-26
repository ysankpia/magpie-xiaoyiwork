import test from "node:test";
import assert from "node:assert/strict";
import { loaderHook } from "../src/hooks/loader.mjs";
import { HAG, MAX_BODY_BYTES, SSE_BASE } from "../src/context.mjs";

const auth = { access: "cred", uid: "1234567890", deviceId: "dev_1" };
const getAuth = async () => auth;

test("超过 4.5 MiB 的请求体前置 413，不打上游", async () => {
  const realFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("should not reach the vendor");
  };
  try {
    const { fetch } = await loaderHook()(getAuth);
    const body = JSON.stringify({
      model: "xiaoyiwork/DeepSeek_V4.1_Flash_VE",
      messages: [{ role: "user", content: "x".repeat(MAX_BODY_BYTES + 1024) }],
    });
    const res = await fetch(`${SSE_BASE}/chat/completions`, {
      method: "POST",
      body,
    });
    assert.equal(res.status, 413);
    const json = await res.json();
    assert.equal(json.error.code, "request_too_large");
    assert.equal(called, false, "超限时不能真的发出去");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("只向上游源发请求，其他源直接拒绝", async () => {
  const { fetch } = await loaderHook()(getAuth);
  await assert.rejects(
    () =>
      fetch("https://evil.example.com/chat/completions", {
        method: "POST",
        body: "{}",
      }),
    /拒绝/,
  );
});

test("发出去的请求剥掉 provider 前缀、强制 stream、内联 $ref", async () => {
  const realFetch = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    const { fetch } = await loaderHook()(getAuth);
    const body = JSON.stringify({
      model: "xiaoyiwork/LLM_GLM5.3",
      stream: false,
      temperature: 0,
      max_tokens: 100,
      messages: [{ role: "user", content: "hi" }],
      tools: [
        {
          type: "function",
          function: {
            name: "f",
            parameters: {
              type: "object",
              properties: { c: { $ref: "#/$defs/C" } },
              $defs: { C: { type: "string" } },
            },
          },
        },
      ],
    });
    await fetch(`${SSE_BASE}/chat/completions`, { method: "POST", body });
    assert.equal(sent.model, "LLM_GLM5.3");
    assert.equal(sent.stream, true);
    assert.equal(sent.temperature, undefined);
    assert.equal(sent.max_tokens, undefined);
    assert.equal(JSON.stringify(sent).includes("$ref"), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("非补全路径原样透传上游，不改方法", async () => {
  const realFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, init) => {
    seen = { url: String(url), method: init.method };
    return new Response("{}", { status: 200 });
  };
  try {
    const { fetch } = await loaderHook()(getAuth);
    await fetch(`${HAG}/user-ability-gallery/v1/agent/user/query`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(seen.method, "POST");
    assert.match(seen.url, /user-ability-gallery/);
  } finally {
    globalThis.fetch = realFetch;
  }
});
