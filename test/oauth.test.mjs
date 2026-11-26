import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { startCallbackServer } from "../src/xiaoyi/oauth.mjs";

const PORT = 17355;

function portBusy() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.once("error", () => resolve(true));
    probe.listen(PORT, "127.0.0.1", () => probe.close(() => resolve(false)));
  });
}

function get(path, agent) {
  return new Promise((resolve) => {
    const req = http.request(
      `http://127.0.0.1:${PORT}${path}`,
      { agent },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
        res.on("error", (e) => resolve({ err: e.code, body }));
      },
    );
    req.on("error", (e) => resolve({ err: e.code }));
    req.end();
  });
}

test("回调页：结算后再次访问仍给正常页面，不是连接被拒", async (t) => {
  if (await portBusy())
    return t.skip("17355 被占用（小艺Work 或另一次登录在跑）");

  const state = "state-under-test";
  const server = startCallbackServer(state);
  await server.listening;
  const agent = new http.Agent({ keepAlive: true });

  const first = await get(`/auth/callback?code=CODE1&state=${state}`, agent);
  assert.equal(first.status, 200);
  assert.match(first.body, /登录成功/);
  assert.equal(await server.codePromise, "CODE1");

  // 用户刷新 / 浏览器重试 / 另一个标签页 —— 用户报的就是这一步变成打不开的地址
  const second = await get(`/auth/callback?code=CODE1&state=${state}`, agent);
  assert.equal(second.status, 200);
  assert.match(second.body, /这次登录已经结束/);

  const favicon = await get("/favicon.ico", agent);
  assert.equal(favicon.status, 204);

  agent.destroy();
  server.close();
});

test("state 不匹配时拒绝，页面说明原因", async (t) => {
  if (await portBusy()) return t.skip("17355 被占用");

  const server = startCallbackServer("expected");
  await server.listening;
  const r = await get("/auth/callback?code=C&state=wrong");
  assert.match(r.body, /state 不匹配/);
  await assert.rejects(server.codePromise, /state 不匹配/);
  server.close();
});

test("授权失败（error 参数）拒绝并透出原因", async (t) => {
  if (await portBusy()) return t.skip("17355 被占用");

  const server = startCallbackServer("s");
  await server.listening;
  const r = await get(
    "/auth/callback?error=access_denied&error_description=nope",
  );
  assert.match(r.body, /授权失败/);
  await assert.rejects(server.codePromise, /access_denied/);
  server.close();
});
