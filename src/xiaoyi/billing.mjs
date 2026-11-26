// 模型目录 / 积分账单 —— usage 与 provider.models 的数据源
//
// 目录接口缺 x-prd-pkg-name 头网关直接 400（Parameter is not valid）。
// 账单 agentId=1 那路偶发 408，重试 3 次能显著提升成功率。

import { HAG, HEADERS, PATHS, PLATFORM_AGENT_ID } from "../context.mjs";
import { hagHeaders, postJson } from "./protocol.mjs";

/** "消耗8x" / "8x" / 8 / "0.8" → "x8" / "x0.8"；归一不了返回 undefined */
export function normalizeRate(raw) {
  let n;
  if (typeof raw === "number" && Number.isFinite(raw)) n = raw;
  else if (typeof raw === "string") {
    const m = raw.match(/(\d+(?:\.\d+)?)\s*[x×]?/i);
    if (m) n = Number(m[1]);
  }
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return `x${n}`;
}

/** 解析 "20261216235959" 这种北京时间紧凑格式 → ISO；解析不了返回 null */
export function parseCompactTime(value) {
  if (typeof value !== "string") return null;
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  const time = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h) - 8,
    Number(mi),
    Number(s),
  );
  const date = new Date(time);
  return Number.isNaN(date.getTime())
    ? null
    : { iso: date.toISOString(), epoch: time };
}

const num = (v) => {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)))
    return Number(v);
  return 0;
};

/**
 * 账单响应可能被包在 data / result 里（2api 实测并处理了这层）。
 * 当前上游是平铺的，但多剥一层是廉价的保险 —— 读不到会静默变成「没额度」。
 */
export function unwrapEnvelope(json) {
  let cur = json;
  for (let depth = 0; depth < 3; depth++) {
    if (!cur || typeof cur !== "object") return cur;
    let moved = false;
    for (const key of ["data", "result", "resultObject", "dataObject"]) {
      const sub = cur[key];
      if (sub && typeof sub === "object" && !Array.isArray(sub)) {
        cur = sub;
        moved = true;
        break;
      }
    }
    if (!moved) return cur;
  }
  return cur;
}

/** 拉当前账号可见的模型目录；失败返回 null（调用方退回静态表） */
export async function queryCatalog({ credential, uid, deviceId }, signal) {
  const res = await postJson(`${HAG}${PATHS.gallery}`, {
    signal,
    headers: {
      ...hagHeaders({ credential, uid, deviceId }, { sse: false }),
      "x-prd-pkg-name": HEADERS.prdPkgName,
    },
    body: {
      type: "CELIA_CLAW_USER_MODEL_QUERY",
      terminalInfo: {
        agentId: PLATFORM_AGENT_ID,
        brand: "HUAWEI",
        countryCode: "CN",
        deviceType: "PC",
        language: "zh_CN",
        locale: "zh-CN",
        manufacturer: "HUAWEI",
        osType: "Hap",
        phoneType: "ALN-AL80",
        prdVer: "11.6.5.414",
        privacyOption: {},
        sysVer: "OpenHarmony-6.1.1.35(Beta1)",
        ohosApiVersion: 24,
      },
      pagination: { limit: 500, start: "0" },
    },
  });
  if (!res.ok) return null;
  const list = [];
  for (const content of res.json?.contents ?? []) {
    for (const item of content.modelList ?? []) {
      const id = String(item.modelValue || "").trim();
      if (!id) continue;
      list.push({
        id,
        name: String(item.modelName || id).trim(),
        rate: normalizeRate(item.aiPointConsumptionRatio),
      });
    }
  }
  return list.length ? list : null;
}

/**
 * 查某个 agentId 的权益明细；重试后仍失败返回 null。
 *
 * ⚠ 只重试**可能自己好**的失败（网络异常 / 408 / 429 / 5xx）。凭据不变的情况下
 *   401/403/400 重试三次必然是三次同样的失败 —— 白白把上游调用翻三倍。
 */
const retryable = (status) => status >= 500 || status === 408 || status === 429;

export async function queryBilling(
  agentId,
  { credential, uid, deviceId },
  signal,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await postJson(`${HAG}${PATHS.billing}`, {
      signal,
      headers: hagHeaders({ credential, uid, deviceId }, { sse: false }),
      body: {
        accountType: "HW_UID",
        agentId,
        endpoint: {
          device: { brand: "HUAWEI", deviceId },
          eduMode: "NONEDU",
          foregroundPkgName: "",
          isXiaoyiAPP: false,
          language: "zh_CN",
          languageMode: "MANDARIN",
          locale: "default",
        },
      },
    }).catch(() => null);
    if (res?.ok) return unwrapEnvelope(res.json);
    // 网络异常（res 为 null）也重试；状态码不可重试就立刻收手
    if (res && !retryable(res.status)) return null;
    if (signal?.aborted) return null;
    if (attempt < 2)
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
  }
  return null;
}

/** 从 privilegeDetail 的三种形状（["剩余积分：1000"] / 1000 / {remainingPoints}）取剩余积分 */
export function parsePrivilegeDetail(raw) {
  if (raw == null) return 0;
  if (Array.isArray(raw)) {
    return raw.reduce(
      (sum, v) =>
        sum + (typeof v === "number" ? v : firstNumber(String(v ?? ""))),
      0,
    );
  }
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") return firstNumber(raw);
  if (typeof raw === "object") {
    for (const key of [
      "remainingPoints",
      "remainPoint",
      "remainPoints",
      "point",
      "value",
    ]) {
      if (Number.isFinite(Number(raw[key]))) return Number(raw[key]);
    }
  }
  return 0;
}

function firstNumber(s) {
  const m = s.match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : 0;
}

export { num };
