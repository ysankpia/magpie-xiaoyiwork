// 小艺Work（华为小艺）的 magpie 供应商插件
//
// 这个文件只做装配：钩子实现全在 src/ 里。
//   ① config          src/hooks/config.mjs     provider + 静态模型表
//   ② auth.methods    src/hooks/methods.mjs    华为账号浏览器 OAuth（PKCE + 17355 回调）
//   ③ auth.refresh    src/hooks/refresh.mjs    代刷 → 立刻签票（串行锁，合并语义）
//   ④ auth.loader     src/hooks/loader.mjs     HAG 鉴权头、强制 SSE、错误分流
//   ⑤ auth.usage      src/hooks/usage.mjs      会员积分 + 权益包两桶额度
//   ⑥ provider.models src/hooks/models.mjs     目录拉取 + 三态降级
//
// 直连 HAG 网关，不是代理：没有本地 server、没有面板、没有账号池。
// 非官方插件：小艺Work 的接口随时可能变。

import { configHook } from "./src/hooks/config.mjs";
import { authHooks } from "./src/auth.mjs";
import { modelsHook } from "./src/hooks/models.mjs";
import { PROVIDER } from "./src/context.mjs";
import {
  normalizeRate,
  parseCompactTime,
  parsePrivilegeDetail,
  unwrapEnvelope,
} from "./src/xiaoyi/billing.mjs";
import { mapChunk } from "./src/xiaoyi/openai-map.mjs";
import { aggregate, transformSse } from "./src/xiaoyi/sse.mjs";
import { buildAuthorizeUrl } from "./src/xiaoyi/oauth.mjs";
import { usageWindow } from "./src/quota.mjs";
import { stateOf } from "./src/hooks/refresh.mjs";

export const XiaoyiWorkAuthPlugin = async (input) => {
  const magpie = input?.magpie ?? {};
  return {
    config: configHook(),
    // 去重要读 magpie 的 plugin-auth.json，选项要按需读（工厂执行时还没灌进来）
    auth: authHooks({
      configDir: input?.directory ?? null,
      option: magpie.option,
    }),
    provider: {
      id: PROVIDER,
      models: modelsHook(),
    },
  };
};

// 供测试引用（⚠ 入口里只导出一个函数，否则会被当成多个插件）
export const _internal = {
  PROVIDER,
  normalizeRate,
  parseCompactTime,
  parsePrivilegeDetail,
  unwrapEnvelope,
  mapChunk,
  aggregate,
  transformSse,
  buildAuthorizeUrl,
  usageWindow,
  stateOf,
};
