// 共享上下文 —— 所有钩子都读这一份
//
// 上游是华为 HAG 网关（小艺Work 桌面端同款）：
//   推理   POST /celia/v1/sse-api/chat/completions   （只吃 SSE，OpenAI chat 格式）
//   业务   /user-credential/* /user-ability-gallery/* /ability-billing/*
//
// 鉴权三件套：businessCredential（7 天）+ x-uid + x-device-id。
//   x-device-id = sha256(机器种子).hex(小写) + "_" + uid —— 必须是该 uid 名下
//   已登记的设备；首次 createCredential 成功即完成登记。
//
// 续期闭环（不需要小艺Work 常驻）：
//   businessCredential ──网关代刷──> accessToken(1h) ──立刻签票──> 新 businessCredential
//   accessToken 有「新鲜度」窗口（几分钟），两步必须背靠背。

/** 厂商 id：agent 用 `<id>/<model>` 命名 */
export const PROVIDER = "xiaoyiwork";

/** 卡片上显示的供应商名：<中文> <English> */
export const PROVIDER_NAME = "小艺Work XiaoyiWork";

/** 华为 HAG 网关 */
export const HAG = "https://hag-drcn.op.dbankcloud.com";

/** 推理 API 基址 —— loader 的 baseURL，SDK 拼成 <baseURL>/chat/completions */
export const SSE_BASE = `${HAG}/celia/v1/sse-api`;

/** 决定 API 形状：Chat completions */
export const SDK = "@ai-sdk/openai-compatible";

/** 华为 OAuth（小艺Work 桌面端注册的应用） */
export const OAUTH = {
  clientId: "6917612679526496902",
  authorizeUrl: "https://oauth-login.cloud.huawei.com/oauth2/v3/authorize",
  tokenUrl: "https://oauth-login.cloud.huawei.com/oauth2/v3/token",
  redirectUri: "http://127.0.0.1:17355/auth/callback",
  callbackPort: 17355,
  callbackPath: "/auth/callback",
  scope:
    "openid profile https://www.huawei.com/auth/drive https://www.huawei.com/auth/drive.xiaoyiwork",
  codeTtlMs: 5 * 60_000,
};

/** HAG 网关路径（补全由 loader 的 baseURL + SDK 拼，不在这里） */
export const PATHS = {
  credential: "/user-credential/v1/business-credential/create",
  refresh: "/user-credential/v1/xiaoyiwork/refresh-token",
  gallery: "/user-ability-gallery/v1/agent/user/query",
  billing: "/ability-billing/v1/agent-purchases-client/privilege/query",
};

/** 请求头常量（与桌面端一致） */
export const HEADERS = {
  businessId: "WINPC_XIAOYI_WORK",
  requestFrom: "xiaoyiWork",
  prdPkgName: "com.huawei.hmos.vassistant", // 目录接口缺它直接 400
};

/** 平台侧 agent id（权益包挂在它名下） */
export const PLATFORM_AGENT_ID = "agent208b6760552b4fa0b395e5165d0d771e";
/** 会员积分池的 agentId */
export const PREMIUM_AGENT_ID = "1";

/** businessCredential 有效期 7 天；提前 12 小时续 */
export const REFRESH_LEAD_MS = 12 * 3600_000;

/**
 * 上游对请求体的硬上限：超过 5 MiB 不返回 413，而是挂起约 56 秒后返回
 * `408 Request Timeout.`（实测）。前置到 4.5 MiB 直接回标准 413，
 * 让 magpie 的 body_cap 去裁剪最早的历史图片并重试，而不是让用户干等一分钟。
 */
export const MAX_BODY_BYTES = 4_718_592;

/**
 * 回调页结算后保留多久再关服务器。
 *
 * 浏览器取完主文档还会来要 favicon，用户也可能按刷新；结算就 `closeAllConnections()`
 * 的话，第二次请求是 ECONNREFUSED —— 用户只看到一个打不开的地址，以为登录没成功。
 */
export const CALLBACK_GRACE_MS = 3_000;

/**
 * 静态兜底模型表；真实列表由 provider.models 按账号拉取（带倍率）。
 *
 * `modalities.input` 里的 image 是实测出来的（拿写着编号的图逐个问）。
 * `rate` 是上游 aiPointConsumptionRatio 的静态副本，目录拉不到时也能显示倍率。
 * 上游标灰的模型（如 Kimi K3.1 Pro，13x）照列 —— gray 不是可用性信号，实测可用。
 */
export const DEFAULT_MODELS = {
  LLM_DeepSeekV4_Think: {
    name: "DeepSeek-V4-Flash",
    reasoning: true,
    tool_call: true,
    rate: "x1",
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 1_000_000, output: 32_000 },
  },
  "DeepSeek_V4.1_Flash_VE": {
    name: "DeepSeek-V4.1-Flash",
    reasoning: true,
    tool_call: true,
    rate: "x1",
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1_000_000, output: 32_000 },
  },
  "LLM_GLM5.3": {
    name: "GLM-5.3",
    reasoning: true,
    tool_call: true,
    rate: "x8",
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 1_000_000, output: 32_768 },
  },
  "GLM_5.3_FLASH_VE": {
    name: "GLM-5.3-Flash",
    reasoning: true,
    tool_call: true,
    rate: "x0.8",
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1_000_000, output: 32_768 },
  },
  "MiniMax_M3.1_Flash": {
    name: "MiniMax M3.1 Flash",
    reasoning: true,
    tool_call: true,
    rate: "x1",
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1_000_000, output: 32_768 },
  },
  "OpenPanguV2-Pro": {
    name: "openPangu-2.1-Pro",
    reasoning: true,
    tool_call: true,
    rate: "x1",
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 1_000_000, output: 32_000 },
  },
  "Kimi_K3.1_Pro_VE": {
    name: "Kimi K3.1 Pro",
    reasoning: true,
    tool_call: true,
    rate: "x13",
    modalities: { input: ["text", "image"], output: ["text"] },
    limit: { context: 1_000_000, output: 32_768 },
  },
  "Auto-Model": {
    name: "Auto-Model",
    tool_call: true,
    modalities: { input: ["text"], output: ["text"] },
    limit: { context: 1_000_000, output: 32_000 },
  },
};
