// ① config —— 声明 provider + 静态模型表
//
// config.models 不能空 —— 未登录也要有，否则显示 "0 models"。
// 必须用 ??=，否则会覆盖用户在 plugins.json 里的配置。
// 拉到什么列什么，不隐藏（gray 实测不是可用性信号）。

import {
  PROVIDER,
  PROVIDER_NAME,
  SDK,
  SSE_BASE,
  DEFAULT_MODELS,
} from "../context.mjs";

export function configHook() {
  return async (cfg) => {
    cfg.provider ??= {};
    cfg.provider[PROVIDER] ??= {
      name: PROVIDER_NAME,
      npm: SDK,
      api: SSE_BASE,
      // 复制一份：别把 DEFAULT_MODELS 的引用交给宿主去改
      models: { ...DEFAULT_MODELS },
    };
  };
}
