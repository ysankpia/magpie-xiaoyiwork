// 华为 OAuth：PKCE S256 + 127.0.0.1:17355 loopback 回调
//
// ⚠ 登录要占用 17355 端口接回调 —— 小艺Work 桌面端开着会抢这个端口，
//   开浏览器前先探测，占用了直接报错让用户退出它。
// ⚠ Chrome/Edge 会向 127.0.0.1:17355 做空闲预连接：回调服务器不能等
//   server.close(cb) 才继续，否则那条空闲连接会让流程卡死 —— 先 resolve 再 closeAllConnections()。

import crypto from "node:crypto";
import http from "node:http";
import { CALLBACK_GRACE_MS, OAUTH } from "../context.mjs";
import { readJsonSafe, validUid } from "./protocol.mjs";

const b64url = (buf) => Buffer.from(buf).toString("base64url");

export function pkcePair() {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(
    crypto.createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

export function buildAuthorizeUrl(challenge, state) {
  const q = new URLSearchParams({
    response_type: "code",
    access_type: "offline",
    client_id: OAUTH.clientId,
    redirect_uri: OAUTH.redirectUri,
    scope: OAUTH.scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    state,
    display: "page",
  });
  return `${OAUTH.authorizeUrl}?${q.toString()}`;
}

/** 端口空闲返回 true；被占用（小艺Work 常驻等）返回 false */
export async function portFree() {
  const probe = http.createServer();
  try {
    await new Promise((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(OAUTH.callbackPort, "127.0.0.1", resolve);
    });
    return true;
  } catch {
    return false;
  } finally {
    try {
      probe.closeAllConnections?.();
      probe.close();
    } catch {
      /* ignore */
    }
  }
}

/**
 * 起回调服务器，等华为跳回 127.0.0.1:17355/auth/callback?code=…&state=…
 * @returns {{ codePromise: Promise<string>, listening: Promise<void>, close: () => void }}
 */
export function startCallbackServer(expectedState, signal) {
  let settled = false;
  let settle;
  const codePromise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  // 超时 / 取消后没人再 await 它，别让 Node 报 unhandled rejection
  codePromise.catch(() => {});

  const server = http.createServer((req, res) => {
    const url = new URL(
      req.url || "/",
      `http://127.0.0.1:${OAUTH.callbackPort}`,
    );
    const html = (body, status = 200) =>
      res
        .writeHead(status, {
          "content-type": "text/html; charset=utf-8",
          connection: "close",
        })
        .end(
          `<!doctype html><meta charset="utf-8"><body style="font:16px/1.7 system-ui;margin:48px">${body}</body>`,
        );
    // 浏览器取完主文档会自己来要 favicon；给 204，别让它变成一条 404
    if (url.pathname === "/favicon.ico") {
      res.writeHead(204).end();
      return;
    }
    if (url.pathname !== OAUTH.callbackPath) {
      res.writeHead(404, { "content-type": "text/plain" }).end("not found");
      return;
    }
    // ⚠ 已经结算过的会话再来请求（用户刷新、浏览器重试、同时开了两个标签页）必须回一个
    //   正常页面。以前这里结算就关服务器，第二次请求是 ECONNREFUSED ——
    //   用户只看到一个打不开的地址，以为登录根本没成功。
    if (settled) {
      html("<h2>这次登录已经结束</h2><p>回到 magpie 重新发起登录即可。</p>");
      return;
    }
    const code = url.searchParams.get("code");
    const gotState = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error || !code) {
      html("<h2>授权失败</h2><p>回到 magpie 看错误信息。</p>");
      finish(
        "reject",
        new Error(
          `授权回调失败：${error || "缺少 code"} ${url.searchParams.get("error_description") || ""}`,
        ),
      );
      return;
    }
    if (gotState !== expectedState) {
      html("<h2>state 不匹配</h2><p>请重新登录。</p>");
      finish("reject", new Error("回调 state 不匹配（可能是过期的授权链接）"));
      return;
    }
    html("<h2>登录成功 ✅</h2><p>可以关闭这个页面了。</p>");
    finish("resolve", code);
  });

  const timer = setTimeout(
    () => finish("reject", new Error("授权超时（5 分钟）")),
    OAUTH.codeTtlMs,
  );
  timer.unref?.(); // 端口被占时登录会失败，这个 5 分钟定时器不该把进程吊着

  let closing = false;
  function close() {
    if (closing) return;
    closing = true;
    clearTimeout(timer);
    try {
      server.close();
      server.closeAllConnections?.();
    } catch {
      /* 已经关了 */
    }
  }

  // 结算后先让响应写完，再等一会儿关 —— 见 CALLBACK_GRACE_MS
  function finish(kind, value) {
    if (settled) return;
    settled = true;
    settle[kind](value);
    const grace = setTimeout(close, CALLBACK_GRACE_MS);
    grace.unref?.();
  }

  signal?.addEventListener?.("abort", () =>
    finish("reject", new Error("登录已取消")),
  );

  const listening = new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(OAUTH.callbackPort, "127.0.0.1", resolve);
  });
  return { codePromise, listening, close };
}

/**
 * 用授权码换 token（PKCE）。返回 accessToken / refreshToken / id_token claims。
 */
export async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: OAUTH.clientId,
    code_verifier: verifier,
    redirect_uri: OAUTH.redirectUri,
  });
  const res = await fetch(OAUTH.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  const json = readJsonSafe(text) ?? {};
  if (!res.ok || !json.access_token) {
    throw new Error(
      `换 token 失败（HTTP ${res.status}）：${json.error_description || text.slice(0, 200)}`,
    );
  }
  const claims = readJsonSafe(
    Buffer.from(
      String(json.id_token || "").split(".")[1] || "",
      "base64url",
    ).toString("utf8"),
  );
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    expiresIn: Number(json.expires_in) || 3600,
    // id_token 只做了 base64 解码（没验签）—— 拿到的 uid 必须过一遍格式，它会被当对象键用
    uid: validUid(claims?.uid) ? claims.uid : null,
    displayName:
      claims?.display_name || claims?.nickname || claims?.given_name || null,
  };
}
