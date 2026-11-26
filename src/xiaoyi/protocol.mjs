// HAG 网关协议：请求头、POST、错误分类
//
// 所有上游请求都走这里 —— 错误语义只在一处定义（401 与 404 混用会打死整个账号）。

import crypto from "node:crypto";
import os from "node:os";
import { HAG, HEADERS, OAUTH, PATHS } from "../context.mjs";

/** @typedef {{ credential: string, uid: string, deviceId: string }} HagAuth */

const traceId = () => "mp-" + crypto.randomBytes(8).toString("hex");

export function readJsonSafe(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** HAG 网关鉴权头（聊天 / 目录 / 账单共用） */
export function hagHeaders({ credential, uid, deviceId }, { sse = true } = {}) {
  return {
    "content-type": "application/json",
    accept: sse ? "text/event-stream" : "application/json",
    businessCredential: credential,
    "x-uid": uid,
    "x-device-id": deviceId,
    "x-request-from": HEADERS.requestFrom,
    "x-businessId": HEADERS.businessId,
    "x-hag-trace-id": traceId(),
  };
}

/**
 * POST JSON。网络异常抛 Error；HTTP 非 2xx 返回 { ok:false, status, text, json }。
 * @returns {Promise<{ ok: boolean, status: number, text: string, json: any }>}
 */
export async function postJson(url, { headers, body, signal }) {
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, text, json: readJsonSafe(text) };
}

/** 从签票响应的多种可能包装里取 credential 与 validTime（秒） */
export function credentialExtras(json) {
  const credential =
    json?.credentialResult?.businessCredential ||
    json?.credentialResult?.credential ||
    json?.data?.businessCredential ||
    json?.data?.credential ||
    json?.businessCredential ||
    json?.credential ||
    null;
  const validTimeSec =
    (typeof json?.credentialResult?.validTime === "number" &&
      json.credentialResult.validTime) ||
    (typeof json?.data?.validTime === "number" && json.data.validTime) ||
    (typeof json?.validTime === "number" && json.validTime) ||
    null;
  return { credential, validTimeSec };
}

/**
 * 上游错误信息。⚠ 只取结构化字段，**绝不回显原文**：签票/代刷的失败响应是对着
 * 带 Bearer token / refreshToken 的请求回的，网关一旦把请求上下文反射进 desc，
 * token 就顺着错误信息进了 GUI，再进 bug report。
 */
export function upstreamMessage(res) {
  const j = res.json ?? {};
  const msg =
    j.desc || j.message || j.error?.message || (j.code ? String(j.code) : "");
  return msg || `HTTP ${res.status}`;
}

/* ── 设备标识 ──────────────────────────────────────────────────────────── */

/**
 * uid 从上游回来，会被拿去当 x-uid、当状态文件名、当对象键。
 * 只接受纯标识符，且排掉会改原型的三个名字。
 */
const RESERVED_KEYS = new Set(["__proto__", "constructor", "prototype"]);
export const validUid = (v) =>
  typeof v === "string" &&
  /^[A-Za-z0-9_-]{1,64}$/.test(v) &&
  !RESERVED_KEYS.has(v);

let cachedMachineId = null;

/**
 * deviceId 必须是该 uid 名下「已登记」的设备：小艺Work 首次登录时用
 * sha256(机器种子) 登记过，换一个值上游以 `clientId is invalid` 拒绝
 * （名字骗人，其实是设备校验）。首次 createCredential 成功即完成登记。
 */
export function machineId() {
  if (cachedMachineId) return cachedMachineId;
  let user = "unknown";
  try {
    user = os.userInfo().username;
  } catch {
    /* 容器 / CI 里可能连 passwd 都没有 —— 别让整个 loader 挂在构造阶段 */
  }
  cachedMachineId = crypto
    .createHash("sha256")
    .update(`${os.hostname()}|${user}`)
    .digest("hex")
    .toLowerCase();
  return cachedMachineId;
}

export function deviceIdFor(uid) {
  return `${machineId()}_${uid}`;
}

/* ── 凭据：签票 / 代刷 / 续期 ──────────────────────────────────────────── */

/**
 * 用「刚签发」的 accessToken 换 businessCredential。
 * accessToken 必须新鲜（几分钟窗口），否则后端回 clientId is invalid。
 */
export async function createCredential(accessToken, uid, deviceId) {
  const res = await postJson(`${HAG}${PATHS.credential}`, {
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "x-uid": uid,
      "x-client-version": "1.0.0",
      "x-hag-trace-id": traceId(),
    },
    body: {
      deviceId,
      uid,
      clientId: OAUTH.clientId,
      sysVer: "5.0.0",
      version: "1.0.0",
      ts: String(Date.now()),
    },
  });
  const { credential, validTimeSec } = credentialExtras(res.json);
  if (!res.ok || !credential) {
    return {
      ok: false,
      status: res.status,
      message: `${upstreamMessage(res)}（HTTP ${res.status}）`,
    };
  }
  return {
    ok: true,
    credential,
    validTimeSec: validTimeSec ?? Math.floor(Date.now() / 1000) + 7 * 86400,
  };
}

/** 网关代刷：把 refreshToken 交给 HAG 换新 accessToken（client_secret 在服务端） */
export async function gatewayRefreshToken(
  { credential, uid, deviceId },
  refreshToken,
) {
  const res = await postJson(`${HAG}${PATHS.refresh}`, {
    headers: hagHeaders({ credential, uid, deviceId }, { sse: false }),
    body: { refreshToken },
  });
  const token =
    typeof res.json?.token === "string" ? res.json.token.trim() : "";
  // ⚠⚠ 上游在凭据已失效时回 **200 + {"token":"undefined"}** —— 假成功。
  //   只判 !token 会把 "undefined"（9 字符的真字符串）当真 token 放过去，
  //   随后签票必然 401，而错误信息会指向错误的地方。必须显式排除。
  if (!res.ok || !token || token === "undefined" || token === "null") {
    return {
      ok: false,
      status: res.status,
      message: `${upstreamMessage(res)}（HTTP ${res.status}）`,
    };
  }
  return { ok: true, token };
}

/**
 * 完整续期：代刷 → 立刻签票。两步必须紧挨着（accessToken 有新鲜度窗口）。
 * @param {HagAuth & { refreshToken: string }} state
 */
export async function renewCredential(state) {
  const refreshed = await gatewayRefreshToken(state, state.refreshToken);
  if (!refreshed.ok)
    return { ok: false, message: `网关代刷失败：${refreshed.message}` };
  const created = await createCredential(
    refreshed.token,
    state.uid,
    state.deviceId,
  );
  if (!created.ok)
    return { ok: false, message: `签票失败：${created.message}` };
  return {
    ok: true,
    credential: created.credential,
    validTimeSec: created.validTimeSec,
  };
}
