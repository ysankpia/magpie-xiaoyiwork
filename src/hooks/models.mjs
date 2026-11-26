// ⑥ provider.models —— 每个账号的模型表
//
// 三态降级：目录失败 → 退回静态表（不返回空表）；单条缺字段 → 不列；
// 登录失效 → 上游目录接口 401/403 时也只退静态表（models 钩子不该打死账号）。
//
// ⚠ 实测（2026-11-25）：上游把几乎所有模型都标 gray:true，但灰度模型实际可用
//   （chat 实测 DeepSeek_V4.1_Flash_VE gray:true 正常回复）—— gray 不是可用性信号。
//   目录拉到什么列什么，不做隐藏。

import { DEFAULT_MODELS } from "../context.mjs";
import { queryCatalog } from "../xiaoyi/billing.mjs";

/**
 * 目录按 uid 缓存。宿主续期成功后会 forgetAccount，紧接着就会重新问 models ——
 * 而目录跟凭据无关（按 uid 返回），不缓存等于每次续期多打一个上游。
 */
const CATALOG_TTL_MS = 10 * 60_000;
const catalogCache = new Map();

async function catalogFor(state, signal) {
  const hit = catalogCache.get(state.uid);
  if (hit && hit.expiresAt > Date.now()) return hit.list;
  const list = await queryCatalog(state, signal).catch(() => null);
  if (list)
    catalogCache.set(state.uid, {
      list,
      expiresAt: Date.now() + CATALOG_TTL_MS,
    });
  return list;
}

export function modelsHook() {
  return async (provider, { auth, signal } = {}) => {
    const uid = auth?.uid;
    const credential = auth?.access;
    // ⚠ 回落必须返回**宿主传进来的那个对象本身**：宿主用引用比较判定"是不是退回了静态表"
    //   （next === given.models）。包一层拷贝，宿主就永远以为拿到了账号的真实目录。
    if (!credential || !uid) return provider.models;

    const catalog = await catalogFor(
      { credential, uid, deviceId: auth?.deviceId || auth?.metadata?.deviceId },
      signal,
    );
    if (!catalog) return provider.models;

    // 无原型表：条目 id 来自上游，`__proto__` 这类键会改掉返回表的原型
    const out = Object.create(null);
    for (const item of catalog) {
      // 目录里出现我们不认识的模型时，只给上游真说了的三件事（名字 + 倍率）。
      // 编 limit / reasoning 是在替上游承诺能力。
      const base = provider.models[item.id] ??
        DEFAULT_MODELS[item.id] ?? { name: item.name };
      const name = item.name || base.name;
      out[item.id] = {
        ...base,
        // 宿主的 info() 只搬固定字段，rate 不在里面会被丢掉 —— 写进显示名才看得见
        name:
          item.rate && !String(name).includes(item.rate)
            ? `${name} · ${item.rate}`
            : name,
      };
    }
    // 兜底：目录没列出的默认模型仍保留（Auto-Model 之类）
    for (const [id, model] of Object.entries(provider.models))
      if (!out[id]) out[id] = model;
    return out;
  };
}
